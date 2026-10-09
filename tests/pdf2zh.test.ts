/**
 * Unit tests for the /pdf2zh pure helpers and output-layout contract.
 *
 * Run with `npm test`. Extension module loading is checked separately via Pi's
 * runtime in `scripts/smoke-extension.sh` (which provides Pi's host modules).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HELP_TEXT, parseArgs } from "../extensions/lib/pdf2zh/args.ts";
import {
	classifyEntries,
	ENGLISH_MD_SUFFIX,
	defaultOutputRoot,
	IMAGES_DIR,
	isSidecar,
	NESTED_DIR,
	originalPdfName,
	localizedPaperNames,
	paperTitleFromMarkdown,
	pdfStem,
	planHoist,
	RAW_DIR,
	renderTree,
	renderLocalizedTree,
	sanitizePaperTitle,
	sourceMdPath,
	targetDirFor,
	translatedMdPath,
	TRANSLATED_MD_SUFFIX,
} from "../extensions/lib/pdf2zh/layout.ts";
import { parseLogLine, progressBar, stripLogPrefix, tailLines } from "../extensions/lib/pdf2zh/progress.ts";
import { buildArgs } from "../extensions/lib/pdf2zh/runner.ts";
import { STAGE_LABEL, type Stage } from "../extensions/lib/pdf2zh/types.ts";

const CWD = "/work";
const PDF = "/papers/2608.01347.pdf";
const STEM = "2608.01347";

// ---------------------------------------------------------------------------
describe("layout: paths", () => {
	it("derives the stem, dropping only a .pdf suffix", () => {
		assert.equal(pdfStem("/papers/2608.01347.pdf"), "2608.01347");
		assert.equal(pdfStem("/papers/2608.01347.PDF"), "2608.01347");
		assert.equal(pdfStem("/papers/notes.tar.pdf"), "notes.tar");
		// No .pdf suffix: the name is already a stem.
		assert.equal(pdfStem("/papers/already-extracted"), "already-extracted");
	});

	it("puts the per-PDF directory under the output root", () => {
		assert.equal(targetDirFor("/out", PDF), "/out/2608.01347");
		assert.equal(targetDirFor("/out/", PDF), "/out/2608.01347");
	});

	it("names the three deliverables", () => {
		const dir = targetDirFor("/out", PDF);
		assert.equal(translatedMdPath(dir, STEM), "/out/2608.01347/2608.01347_zh.md");
		assert.equal(sourceMdPath(dir, STEM), "/out/2608.01347/2608.01347.md");
		assert.equal(originalPdfName(PDF), "2608.01347.pdf");
	});

	it("defaults the output root to the PDF's own directory", () => {
		assert.equal(defaultOutputRoot(PDF), "/papers");
	});

	it("does not collapse when the stem equals the directory holding the PDF", () => {
		// /papers/papers.pdf -> /papers/papers/, never a collision with the source.
		assert.equal(targetDirFor("/papers", "/papers/papers.pdf"), "/papers/papers");
	});
});

// ---------------------------------------------------------------------------
describe("layout: Obsidian localized paper names", () => {
	it("uses the first meaningful H1 and sanitizes it as one path segment", () => {
		const title = paperTitleFromMarkdown("# Abstract\n\n# **ReAct: Reasoning/Acting**", "paper.pdf");
		assert.equal(title, "ReAct： Reasoning／Acting");
	});

	it("falls back to the PDF stem when no suitable H1 exists", () => {
		assert.equal(paperTitleFromMarkdown("## Not an H1", "a/b.pdf"), "a／b.pdf");
		assert.equal(paperTitleFromMarkdown("# 引言\n# Abstract", "paper.pdf"), "paper.pdf");
	});

	it("uses localized file suffixes and always lists images/", () => {
		const title = "论文标题";
		assert.deepEqual(localizedPaperNames(title), {
			pdf: `${title}.pdf`,
			englishMd: `${title}${ENGLISH_MD_SUFFIX}`,
			translatedMd: `${title}${TRANSLATED_MD_SUFFIX}`,
		});
		assert.ok(renderLocalizedTree(title, 0).some((line) => line.includes("images/")));
		assert.equal(sanitizePaperTitle("../bad:name"), "..／bad：name");
	});
});

// ---------------------------------------------------------------------------
describe("layout: classifyEntries", () => {
	const ctx = { stem: STEM, originalPdfName: "2608.01347.pdf", translated: true };

	it("keeps the three deliverables at the top level", () => {
		const out = classifyEntries(
			[
				{ name: "2608.01347_zh.md", isDirectory: false },
				{ name: "2608.01347.pdf", isDirectory: false },
				{ name: IMAGES_DIR, isDirectory: true },
			],
			ctx,
		);
		assert.deepEqual(
			out.map((c) => [c.kind, c.name]),
			[
				["keep", "2608.01347_zh.md"],
				["keep", "2608.01347.pdf"],
				["keep", "images"],
			],
		);
	});

	it("sends the English markdown to _raw", () => {
		const out = classifyEntries([{ name: "2608.01347.md", isDirectory: false }], ctx);
		assert.equal(out[0]!.kind, "raw");
		assert.match(out[0]!.reason, /英文原版/);
	});

	it("sends MinerU sidecars to _raw", () => {
		const names = [
			"2608.01347_layout.pdf",
			"2608.01347_origin.pdf",
			"2608.01347_content_list.json",
			"2608.01347_middle.json",
		];
		const out = classifyEntries(
			names.map((name) => ({ name, isDirectory: false })),
			ctx,
		);
		assert.ok(out.every((c) => c.kind === "raw"));
	});

	it("never treats the original PDF as a sidecar even when it looks like one", () => {
		// A PDF literally named `<stem>_origin.pdf` copied in as the source would
		// otherwise be archived away; originalPdfName must win.
		const out = classifyEntries([{ name: "2608.01347_origin.pdf", isDirectory: false }], {
			stem: STEM,
			originalPdfName: "2608.01347_origin.pdf",
			translated: true,
		});
		assert.equal(out[0]!.kind, "keep");
	});

	it("routes an unknown subdirectory to _raw", () => {
		const out = classifyEntries([{ name: "weird", isDirectory: true }], ctx);
		assert.equal(out[0]!.kind, "raw");
	});

	it("is idempotent: an existing _raw/ is kept, not re-archived", () => {
		const out = classifyEntries([{ name: RAW_DIR, isDirectory: true }], ctx);
		assert.equal(out[0]!.kind, "keep");
	});

	it("flags the untranslated case in the reason text", () => {
		const out = classifyEntries([{ name: "2608.01347_zh.md", isDirectory: false }], { ...ctx, translated: false });
		assert.equal(out[0]!.kind, "keep");
		assert.match(out[0]!.reason, /未翻译/);
	});
});

// ---------------------------------------------------------------------------
describe("layout: sidecar detection", () => {
	it("recognizes MinerU sidecar shapes", () => {
		for (const n of ["p_middle.json", "p_content_list.json", "p_layout.pdf", "p_origin.pdf", "p.json"]) {
			assert.equal(isSidecar(n), true, n);
		}
	});

	it("does not mistake deliverables for sidecars", () => {
		assert.equal(isSidecar("p_zh.md"), false);
		assert.equal(isSidecar("p.pdf"), false);
		assert.equal(isSidecar("p.md"), false);
	});
});

// ---------------------------------------------------------------------------
describe("layout: planHoist (local mineru auto/ nesting)", () => {
	it("moves everything when nothing collides", () => {
		const out = planHoist([
			{ name: "2608.01347_zh.md", isDirectory: false },
			{ name: IMAGES_DIR, isDirectory: true },
		]);
		assert.deepEqual(out.move, ["2608.01347_zh.md", "images"]);
		assert.deepEqual(out.conflict, []);
	});

	it("protects the original PDF from a same-named MinerU output", () => {
		const out = planHoist(
			[
				{ name: "2608.01347.pdf", isDirectory: false },
				{ name: IMAGES_DIR, isDirectory: true },
			],
			["2608.01347.pdf"],
		);
		assert.deepEqual(out.move, ["images"]);
		assert.deepEqual(out.conflict, ["2608.01347.pdf"]);
	});

	it("names the nesting directory the local CLI actually uses", () => {
		assert.equal(NESTED_DIR, "auto");
	});
});

// ---------------------------------------------------------------------------
describe("layout: renderTree", () => {
	it("renders all three deliverables plus _raw", () => {
		const lines = renderTree({
			stem: STEM,
			originalPdfName: "2608.01347.pdf",
			translatedMd: true,
			imageCount: 3,
			rawCount: 5,
		});
		assert.equal(lines[0], "2608.01347/");
		assert.ok(lines.some((l) => l.includes("2608.01347_zh.md")));
		assert.ok(lines.some((l) => l.includes("images/")));
		assert.ok(lines.some((l) => l.includes("2608.01347.pdf")));
		assert.ok(lines.some((l) => l.includes("_raw/")));
	});

	it("marks a missing translation", () => {
		const lines = renderTree({ stem: STEM, originalPdfName: "2608.01347.pdf", translatedMd: false, imageCount: 0, rawCount: 0 });
		assert.ok(lines.some((l) => l.includes("缺失")));
	});

	it("still shows images/ when the PDF had none", () => {
		const lines = renderTree({ stem: STEM, originalPdfName: "2608.01347.pdf", translatedMd: true, imageCount: 0, rawCount: 0 });
		assert.ok(lines.some((l) => l.includes("images/") && l.includes("空")));
	});
});

// ---------------------------------------------------------------------------
describe("args: parseArgs", () => {
	it("returns help without options", () => {
		const p = parseArgs("--help", CWD);
		assert.equal(p.help, true);
		assert.equal(p.options, undefined);
	});

	it("errors on empty input", () => {
		assert.match(parseArgs("   ", CWD).error ?? "", /缺少 PDF 路径/);
	});

	it("resolves a relative PDF path against cwd and warns", () => {
		const p = parseArgs("a/b.pdf", CWD);
		assert.equal(p.options?.pdfPath, "/work/a/b.pdf");
		assert.equal(p.warnings?.length, 1);
	});

	it("defaults the output root to the PDF's directory", () => {
		assert.equal(parseArgs(PDF, CWD).options?.outputRoot, "/papers");
	});

	it("accepts -o as the output root", () => {
		const p = parseArgs(`${PDF} -o /out`);
		assert.equal(p.options?.outputRoot, "/out");
	});

	it("applies pipeline defaults", () => {
		const o = parseArgs(PDF, CWD).options!;
		assert.equal(o.ocr, "api");
		assert.equal(o.backend, "pipeline");
		assert.equal(o.lang, "en");
		assert.equal(o.model, "MiniMax-M3");
		assert.equal(parseArgs(PDF, CWD).modelSpecified, false);
		assert.equal(o.workers, 8);
		assert.equal(o.chunkSize, 3000);
		assert.equal(o.skipTranslate, false);
		assert.equal(o.force, false);
	});

	it("parses every documented flag", () => {
		const o = parseArgs(
			`${PDF} --ocr local -b vlm-auto-engine -l ch --model MiniMax-M2 --base-url https://gateway.example/v1 --workers 4 --chunk-size 1500 --skip-translate --force`,
			CWD,
		).options!;
		assert.equal(o.ocr, "local");
		assert.equal(o.backend, "vlm-auto-engine");
		assert.equal(o.lang, "ch");
		assert.equal(o.model, "MiniMax-M2");
		assert.equal(o.baseUrl, "https://gateway.example/v1");
		assert.equal(parseArgs(`${PDF} --model gemini-3.7-flash`, CWD).modelSpecified, true);
		assert.equal(o.workers, 4);
		assert.equal(o.chunkSize, 1500);
		assert.equal(o.skipTranslate, true);
		assert.equal(o.force, true);
	});

	it("rejects an invalid --ocr value", () => {
		assert.match(parseArgs(`${PDF} --ocr gpu`, CWD).error ?? "", /--ocr 只支持/);
	});

	it("rejects non-numeric and non-positive counts", () => {
		assert.match(parseArgs(`${PDF} --workers abc`, CWD).error ?? "", /--workers/);
		assert.match(parseArgs(`${PDF} --workers 0`, CWD).error ?? "", /--workers/);
		assert.match(parseArgs(`${PDF} --chunk-size -1`, CWD).error ?? "", /--chunk-size/);
	});

	it("rejects an unknown flag rather than passing it through", () => {
		assert.match(parseArgs(`${PDF} --verbose`, CWD).error ?? "", /未知选项/);
	});

	it("rejects a flag missing its value", () => {
		assert.match(parseArgs(`${PDF} -o`, CWD).error ?? "", /缺少取值/);
	});

	it("rejects a second positional argument", () => {
		assert.match(parseArgs(`${PDF} ${PDF}`, CWD).error ?? "", /多余的位置参数/);
	});

	it("documents the output contract in the help text", () => {
		for (const needle of ["_zh.md", "images/", "_raw/"]) {
			assert.ok(HELP_TEXT.includes(needle), needle);
		}
	});
});

// ---------------------------------------------------------------------------
describe("progress: parseLogLine", () => {
	it("recognizes the OCR stage marker", () => {
		const p = parseLogLine("21:11:03 INFO [1/2] PDF -> Markdown (ocr=api)");
		assert.equal(p?.stage, "ocr");
		assert.match(p!.detail!, /PDF -> Markdown/);
	});

	it("recognizes the translate stage marker", () => {
		const p = parseLogLine("21:11:05 INFO [2/2] Translating with MiniMax-M3 (workers=8)");
		assert.equal(p?.stage, "translating");
	});

	it("does not read the [1/2] stage marker as a 50% counter", () => {
		const p = parseLogLine("21:11:03 INFO [1/2] PDF -> Markdown (ocr=api)");
		assert.equal(p?.done, undefined);
		assert.equal(p?.total, undefined);
	});

	it("reads translation progress as done/total", () => {
		const p = parseLogLine("21:11:09 INFO [37/120] chunk #5 ok");
		assert.equal(p?.stage, "translating");
		assert.equal(p?.done, 37);
		assert.equal(p?.total, 120);
	});

	it("captures the chunk count", () => {
		const p = parseLogLine("21:11:05 INFO 12 chunks");
		assert.equal(p?.stage, "chunking");
		assert.equal(p?.total, 12);
	});

	it("recognizes completion", () => {
		assert.equal(parseLogLine("21:11:30 INFO Done: /out/2608.01347_zh.md")?.stage, "finalize");
	});

	it("keeps routine OCR chatter as an idle detail", () => {
		const p = parseLogLine("21:11:04 INFO batch_id=abc-123，开始上传 2608.01347.pdf（3.2 MB）");
		assert.equal(p?.stage, "idle");
		assert.match(p!.detail!, /batch_id/);
	});

	it("parses retry noise printed raw to stderr", () => {
		const p = parseLogLine("  error: rate limit; retry in 4s");
		assert.equal(p, null, "raw stderr chatter is not a progress event");
	});

	it("ignores blank lines", () => {
		assert.equal(parseLogLine(""), null);
		assert.equal(parseLogLine("   \n"), null);
	});

	it("preserves the raw line for the log tail", () => {
		const raw = "21:11:09 INFO [1/1] chunk #1 ok";
		assert.equal(parseLogLine(raw)?.raw, raw);
	});

	it("strips the logging prefix", () => {
		assert.equal(stripLogPrefix("21:11:03 INFO hello"), "hello");
		assert.equal(stripLogPrefix("plain line"), "plain line");
	});
});

describe("progress: tailLines", () => {
	it("keeps the last n lines", () => {
		assert.deepEqual(tailLines(["a", "b", "c", "d"], 2), ["c", "d"]);
	});

	it("returns everything when n exceeds the length", () => {
		assert.deepEqual(tailLines(["a"], 30), ["a"]);
	});

	it("handles an empty buffer", () => {
		assert.deepEqual(tailLines([], 30), []);
	});
});

// ---------------------------------------------------------------------------
describe("runner: buildArgs", () => {
	const base = {
		pdfPath: PDF,
		outputRoot: "/out",
		ocr: "api",
		backend: "pipeline",
		lang: "en",
		model: "MiniMax-M3",
		workers: 8,
		chunkSize: 3000,
		skipTranslate: false,
		force: false,
	} as const;

	it("passes the output ROOT, because the script appends <stem>/ itself", () => {
		const args = buildArgs(base);
		const i = args.indexOf("-o");
		assert.equal(args[i + 1], "/out");
		assert.equal(args[i + 2]?.endsWith(".pdf"), false, "-o must not already carry the stem");
	});

	it("forwards model and optional OpenAI-compatible base URL", () => {
		const args = buildArgs({ ...base, workers: 2, chunkSize: 800, model: "gemini-3.7-flash", baseUrl: "https://gateway.example/v1" });
		assert.ok(args.includes("--ocr"));
		assert.ok(args.includes("--workers"));
		assert.ok(args.includes("--chunk-size"));
		assert.ok(args.includes("800"));
		assert.ok(args.includes("gemini-3.7-flash"));
		const baseUrlIndex = args.indexOf("--base-url");
		assert.equal(args[baseUrlIndex + 1], "https://gateway.example/v1");
	});

	it("adds --skip-translate only when asked", () => {
		assert.equal(buildArgs(base).includes("--skip-translate"), false);
		assert.equal(buildArgs({ ...base, skipTranslate: true }).includes("--skip-translate"), true);
	});
});

// ---------------------------------------------------------------------------
describe("view: progressBar", () => {
	it("fills proportionally", () => {
		assert.equal(progressBar(0, 4), "░░░░");
		assert.equal(progressBar(0.5, 4), "██░░");
		assert.equal(progressBar(1, 4), "████");
	});

	it("clamps out-of-range and non-finite input", () => {
		assert.equal(progressBar(-5, 4), "░░░░");
		assert.equal(progressBar(9, 4), "████");
		assert.equal(progressBar(Number.NaN, 4), "░░░░");
	});

	it("always returns the requested width", () => {
		for (const r of [0, 0.13, 0.5, 0.99, 1]) {
			assert.equal(progressBar(r, 10).length, 10);
		}
	});
});

describe("types: STAGE_LABEL", () => {
	it("labels every stage", () => {
		const stages: Stage[] = ["idle", "prepare", "ocr", "chunking", "translating", "finalize", "done", "failed"];
		for (const s of stages) {
			assert.equal(typeof STAGE_LABEL[s], "string", s);
			assert.ok(STAGE_LABEL[s].length > 0, s);
		}
	});
});
