import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { runBatchPipeline } from "../extensions/lib/pdf2zh/batch.ts";
import { IMAGES_DIR } from "../extensions/lib/pdf2zh/layout.ts";
import { createFakeProject } from "./fake-project.ts";

const originalProjectDir = process.env.PDF2ZH_PROJECT_DIR;
const originalFakeMode = process.env.FAKE_MODE;
const originalFakeTitle = process.env.FAKE_TITLE;
const originalNoH1 = process.env.FAKE_NO_H1;
let scratch: string;
let libraryRoot: string;

async function makePdf(name: string): Promise<string> {
	const path = join(scratch, "inputs", name);
	await mkdir(join(scratch, "inputs"), { recursive: true });
	await writeFile(path, `%PDF-1.4\n${name}\n`);
	return path;
}

function options(pdfPaths: string[], extra: Partial<Parameters<typeof runBatchPipeline>[0]> = {}) {
	return {
		pdfPaths,
		category: "02-上下文工程",
		libraryRoot,
		model: "MiniMax-M3.1-Flash-Preview",
		workers: 1,
		chunkSize: 800,
		...extra,
	};
}

before(async () => {
	scratch = await mkdtemp(join(tmpdir(), "pi-paper-translator-batch-"));
	libraryRoot = join(scratch, "library");
	const fakeProject = join(scratch, "fake-project");
	await createFakeProject(fakeProject);
	process.env.PDF2ZH_PROJECT_DIR = fakeProject;
	process.env.FAKE_MODE = "api";
});

after(async () => {
	await rm(scratch, { recursive: true, force: true });
	if (originalProjectDir === undefined) delete process.env.PDF2ZH_PROJECT_DIR;
	else process.env.PDF2ZH_PROJECT_DIR = originalProjectDir;
	if (originalFakeMode === undefined) delete process.env.FAKE_MODE;
	else process.env.FAKE_MODE = originalFakeMode;
	if (originalFakeTitle === undefined) delete process.env.FAKE_TITLE;
	else process.env.FAKE_TITLE = originalFakeTitle;
	if (originalNoH1 === undefined) delete process.env.FAKE_NO_H1;
	else process.env.FAKE_NO_H1 = originalNoH1;
});

describe("batch paper publishing", () => {
	it("stages multiple PDFs into the same category with localized names and working image links", async () => {
		const alpha = await makePdf("alpha.pdf");
		const beta = await makePdf("beta.pdf");
		const result = await runBatchPipeline(options([alpha, beta]));

		assert.equal(result.ok, true, result.error);
		assert.equal(result.papers.length, 2);
		const categoryDir = join(libraryRoot, "02-上下文工程");
		assert.equal(result.categoryDir, categoryDir);
		for (const paper of result.papers) {
			assert.equal(paper.targetDir, join(categoryDir, paper.title));
			assert.ok(existsSync(join(paper.targetDir, `${paper.title}.pdf`)));
			assert.ok(existsSync(join(paper.targetDir, `${paper.title}_英文.md`)));
			const translated = join(paper.targetDir, `${paper.title}_全文翻译.md`);
			assert.ok(existsSync(translated));
			const markdown = await readFile(translated, "utf8");
			assert.match(markdown, /!\[图 1\]\(images\/fig1\.png\)/);
			assert.ok(existsSync(join(paper.targetDir, IMAGES_DIR, "fig1.png")));
		}
	});

	it("falls back to the PDF filename when the translated Markdown has no H1", async () => {
		process.env.FAKE_NO_H1 = "1";
		const pdf = await makePdf("noheading.pdf");
		const result = await runBatchPipeline(options([pdf]));
		delete process.env.FAKE_NO_H1;
		assert.equal(result.ok, true, result.error);
		assert.equal(result.papers[0]?.title, "noheading");
	});

	it("rejects same-batch title collisions before publishing anything", async () => {
		process.env.FAKE_TITLE = "重名论文";
		const alpha = await makePdf("dup-a.pdf");
		const beta = await makePdf("dup-b.pdf");
		const duplicateLibrary = join(scratch, "duplicate-library");
		const result = await runBatchPipeline(options([alpha, beta], { libraryRoot: duplicateLibrary }));
		delete process.env.FAKE_TITLE;

		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /重复的中文标题/);
		assert.equal(existsSync(duplicateLibrary), false);
	});

	it("fails closed on existing output without confirmation, then replaces only after approval", async () => {
		const pdf = await makePdf("overwrite.pdf");
		const first = await runBatchPipeline(options([pdf]));
		assert.equal(first.ok, true, first.error);
		const target = first.papers[0]!.targetDir;
		const sentinel = join(target, "keep-unless-confirmed.txt");
		await writeFile(sentinel, "original user data");

		const refused = await runBatchPipeline(options([pdf]));
		assert.equal(refused.ok, false);
		assert.match(refused.error ?? "", /未获得人工覆盖确认/);
		assert.equal(await readFile(sentinel, "utf8"), "original user data");

		const approved = await runBatchPipeline(options([pdf]), { confirmOverwrite: async () => true });
		assert.equal(approved.ok, true, approved.error);
		assert.deepEqual(approved.overwritten, [target]);
		assert.equal(existsSync(sentinel), false);
	});

	it("keeps the library untouched if any pipeline run fails", async () => {
		process.env.FAKE_MODE = "fail";
		const pdf = await makePdf("failure.pdf");
		const absentLibrary = join(scratch, "failed-library");
		const result = await runBatchPipeline(options([pdf], { libraryRoot: absentLibrary }));
		process.env.FAKE_MODE = "api";
		assert.equal(result.ok, false);
		assert.equal(existsSync(absentLibrary), false);
	});

	it("rejects path-traversal category names", async () => {
		const pdf = await makePdf("traversal.pdf");
		const result = await runBatchPipeline(options([pdf], { category: ".." }));
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /分类目录不能是/);
	});
});
