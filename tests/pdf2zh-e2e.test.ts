/**
 * Offline end-to-end harness for the /pdf2zh runner.
 *
 * Runs the REAL runPipeline against a fake project (PDF2ZH_PROJECT_DIR) that
 * emulates both MinerU output shapes, then asserts the output contract on disk:
 *   1. translated markdown at the target dir root
 *   2. images/ at the target dir root, and every ![](...) reference resolves
 *   3. the original PDF copied in
 *   4. sidecars archived to _raw/, nothing else polluting the top level
 *
 * Run with `npm test` from the repository root.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { IMAGES_DIR, RAW_DIR } from "../extensions/lib/pdf2zh/layout.ts";
import { runPipeline } from "../extensions/lib/pdf2zh/runner.ts";
import { createFakeProject } from "./fake-project.ts";

const originalProjectDir = process.env.PDF2ZH_PROJECT_DIR;
const originalFakeMode = process.env.FAKE_MODE;

/** Minimal but non-empty stand-in for a real PDF. */
async function makePdf(dir: string, name: string): Promise<string> {
	const p = join(dir, name);
	await writeFile(p, "%PDF-1.4\n% fake pdf for harness\n" + "0".repeat(2048), "utf8");
	return p;
}

/** Every `![](path)` reference in a markdown file, as written. */
function imageRefs(md: string): string[] {
	return [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]!);
}

let scratch: string;

before(async () => {
	scratch = await mkdtemp(join(tmpdir(), "pdf2zh-e2e-"));
	const fakeProject = join(scratch, "fake-project");
	await createFakeProject(fakeProject);
	process.env.PDF2ZH_PROJECT_DIR = fakeProject;
});

after(async () => {
	await rm(scratch, { recursive: true, force: true });
	if (originalProjectDir === undefined) delete process.env.PDF2ZH_PROJECT_DIR;
	else process.env.PDF2ZH_PROJECT_DIR = originalProjectDir;
	if (originalFakeMode === undefined) delete process.env.FAKE_MODE;
	else process.env.FAKE_MODE = originalFakeMode;
});

function options(pdfPath: string, outputRoot: string, over: Partial<Parameters<typeof runPipeline>[0]> = {}) {
	return {
		pdfPath,
		outputRoot,
		ocr: "api" as const,
		backend: "pipeline",
		lang: "en",
		model: "MiniMax-M3",
		workers: 8,
		chunkSize: 3000,
		skipTranslate: false,
		force: true,
		...over,
	};
}

describe("e2e: cloud API layout (default)", () => {
	it("produces the 3 deliverables + _raw, with all image refs resolving", async () => {
		process.env.FAKE_MODE = "api";
		const root = join(scratch, "api");
		await mkdir(root, { recursive: true });
		const pdf = await makePdf(root, "2608.01347.pdf");

		const seen: string[] = [];
		const r = await runPipeline(options(pdf, root), { onProgress: (p) => seen.push(p.stage) });

		assert.equal(r.ok, true, `pipeline failed: ${r.error}\n${r.logTail.join("\n")}`);

		const dir = r.targetDir;
		assert.equal(dir, join(root, "2608.01347"));

		// 1. translated markdown at the root
		const zh = join(dir, "2608.01347_zh.md");
		assert.ok(existsSync(zh), "translated markdown missing");
		assert.equal(r.translatedMd, zh);

		// 2. images/ at the root, and EVERY relative reference resolves on disk
		const images = join(dir, IMAGES_DIR);
		assert.ok(existsSync(images), "images/ missing at the target root");
		assert.equal(r.imagesDir, images);
		const refs = imageRefs(await readFile(zh, "utf8"));
		assert.equal(refs.length, 3);
		for (const ref of refs) {
			assert.ok(ref.startsWith("images/"), `unexpected absolute ref ${ref}`);
			assert.ok(existsSync(join(dir, ref)), `dangling image reference: ${ref}`);
		}

		// 3. the original PDF, byte-identical
		const copied = join(dir, "2608.01347.pdf");
		assert.ok(existsSync(copied), "original PDF not copied in");
		assert.equal(r.originalPdf, copied);
		assert.equal(
			(await readFile(copied)).length,
			(await readFile(pdf)).length,
			"copied PDF size differs from the source",
		);

		// 4. sidecars archived; top level holds exactly the contract
		const raw = join(dir, RAW_DIR);
		assert.ok(existsSync(raw), "_raw/ missing");
		const rawFiles = await readdir(raw);
		assert.ok(rawFiles.includes("2608.01347.md"), "English markdown should be in _raw/");
		assert.ok(rawFiles.some((f) => f.endsWith("_layout.pdf")), "MinerU sidecar should be in _raw/");

		const top = (await readdir(dir)).sort();
		assert.deepEqual(top, ["2608.01347.pdf", "2608.01347_zh.md", IMAGES_DIR, RAW_DIR].sort());

		// progress events were streamed (stage machine advanced)
		assert.ok(seen.includes("ocr"), "no ocr stage emitted");
		assert.ok(seen.includes("translating"), "no translating stage emitted");
	});
});

describe("e2e: local mineru layout (auto/ nesting)", () => {
	it("flattens auto/ so the same contract holds", async () => {
		process.env.FAKE_MODE = "local";
		const root = join(scratch, "local");
		await mkdir(root, { recursive: true });
		const pdf = await makePdf(root, "local-paper.pdf");

		const r = await runPipeline(options(pdf, root, { ocr: "local" }));
		assert.equal(r.ok, true, `pipeline failed: ${r.error}\n${r.logTail.join("\n")}`);

		const dir = r.targetDir;
		assert.ok(!existsSync(join(dir, "auto")), "auto/ should have been hoisted away");
		assert.ok(existsSync(join(dir, "local-paper_zh.md")), "translated md not at the root");
		assert.ok(existsSync(join(dir, IMAGES_DIR)), "images/ not at the root");
		assert.ok(existsSync(join(dir, "local-paper.pdf")), "original PDF missing");

		// the hoisted markdown's references must still resolve from the new depth
		const zh = join(dir, "local-paper_zh.md");
		for (const ref of imageRefs(await readFile(zh, "utf8"))) {
			assert.ok(existsSync(join(dir, ref)), `dangling ref after hoist: ${ref}`);
		}

		const top = (await readdir(dir)).sort();
		assert.deepEqual(top, [IMAGES_DIR, RAW_DIR, "local-paper.pdf", "local-paper_zh.md"].sort());
	});
});

describe("e2e: original PDF is never clobbered by a same-named MinerU output", () => {
	it("keeps our copy when auto/ carries an identical name", async () => {
		process.env.FAKE_MODE = "local";
		const root = join(scratch, "clash");
		await mkdir(root, { recursive: true });
		// Source PDF named like a MinerU sidecar it would also produce.
		const pdf = await makePdf(root, "clash_layout.pdf");
		const before = await readFile(pdf);

		const r = await runPipeline(options(pdf, root, { ocr: "local" }));
		assert.equal(r.ok, true, r.error);

		const copied = join(r.targetDir, "clash_layout.pdf");
		assert.equal((await readFile(copied)).toString(), before.toString(), "original PDF was overwritten");
	});
});

describe("e2e: skipTranslate", () => {
	it("keeps the English markdown at the root and reports the missing translation", async () => {
		process.env.FAKE_MODE = "api";
		const root = join(scratch, "skip");
		await mkdir(root, { recursive: true });
		const pdf = await makePdf(root, "skipme.pdf");

		const r = await runPipeline(options(pdf, root, { skipTranslate: true }));
		assert.equal(r.ok, true, r.error);
		assert.equal(r.translatedMd, undefined, "no translation should be reported");
		assert.ok(r.tree.some((l) => l.includes("缺失")), `tree should flag the missing zh md:\n${r.tree.join("\n")}`);
		// The English md is moved to _raw, so the root stays clean.
		assert.ok(existsSync(join(r.targetDir, RAW_DIR, "skipme.md")));
	});
});

describe("e2e: idempotence and force", () => {
	it("skips an already-translated directory without force", async () => {
		process.env.FAKE_MODE = "api";
		const root = join(scratch, "idem");
		await mkdir(root, { recursive: true });
		const pdf = await makePdf(root, "idem.pdf");

		const first = await runPipeline(options(pdf, root, { force: false }));
		assert.equal(first.ok, true);
		const stamp = (await readFile(join(first.targetDir, "idem_zh.md"), "utf8")).length;

		const second = await runPipeline(options(pdf, root, { force: false }));
		assert.equal(second.skipped, true, "second run should skip");
		assert.equal(second.ok, true);
		// Untouched: same content, and the original PDF was not re-copied over anything.
		assert.equal((await readFile(join(first.targetDir, "idem_zh.md"), "utf8")).length, stamp);
	});

	it("re-runs under --force and clears stale sidecars", async () => {
		process.env.FAKE_MODE = "api";
		const root = join(scratch, "force");
		await mkdir(root, { recursive: true });
		const pdf = await makePdf(root, "forced.pdf");

		await runPipeline(options(pdf, root, { force: false }));
		// Plant a stale file from a "previous" run.
		await writeFile(join(root, "forced", RAW_DIR, "stale_leftover.json"), "{}");

		const r = await runPipeline(options(pdf, root, { force: true }));
		assert.equal(r.ok, true, r.error);
		assert.ok(!existsSync(join(r.targetDir, RAW_DIR, "stale_leftover.json")), "stale sidecar survived --force");
		assert.ok(existsSync(join(r.targetDir, "forced_zh.md")));
	});
});

describe("e2e: failure paths never lose the original PDF", () => {
	it("returns ok:false with a log tail when the pipeline exits non-zero", async () => {
		process.env.FAKE_MODE = "fail";
		const root = join(scratch, "fail");
		await mkdir(root, { recursive: true });
		const pdf = await makePdf(root, "doomed.pdf");

		const r = await runPipeline(options(pdf, root));
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /退出码/);
		assert.ok(r.logTail.length > 0, "a failing run must surface its log tail");
		// The user's source file is still in place, both at the source and in the output.
		assert.ok(existsSync(pdf));
		assert.equal(r.originalPdf, join(root, "doomed", "doomed.pdf"));
		assert.ok(existsSync(join(root, "doomed", "doomed.pdf")));
	});

	it("reports a missing PDF without creating anything", async () => {
		const root = join(scratch, "missing");
		await mkdir(root, { recursive: true });
		const r = await runPipeline(options(join(root, "ghost.pdf"), root));
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /PDF 不存在/);
		assert.equal((await readdir(root)).length, 0, "no directory should be created for a missing PDF");
	});
});

describe("e2e: abort", () => {
	it("reports cancellation and stops the child", async () => {
		process.env.FAKE_MODE = "api";
		const root = join(scratch, "abort");
		await mkdir(root, { recursive: true });
		const pdf = await makePdf(root, "abortme.pdf");

		const ac = new AbortController();
		ac.abort(); // already aborted before the spawn
		const r = await runPipeline(options(pdf, root), { signal: ac.signal });
		assert.equal(r.cancelled, true);
		assert.equal(r.ok, false);
	});
});
