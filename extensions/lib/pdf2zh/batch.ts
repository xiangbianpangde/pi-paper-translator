import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { IMAGES_DIR, paperTitleFromMarkdown, pdfStem, RAW_DIR, renderLocalizedTree, sanitizePaperTitle, localizedPaperNames } from "./layout.ts";
import { runPipeline, type RunDeps } from "./runner.ts";
import { resolveTranslationBaseUrl, resolveTranslationModel } from "./user-config.ts";
import type { Pdf2zhOptions, Progress } from "./types.ts";

export interface BatchOptions {
	pdfPaths: string[];
	category: string;
	libraryRoot: string;
	model?: string;
	baseUrl?: string;
	workers?: number;
	chunkSize?: number;
}

export interface BatchPaperResult {
	pdfPath: string;
	title: string;
	targetDir: string;
	tree: string[];
}

export interface BatchRunResult {
	ok: boolean;
	categoryDir: string;
	papers: BatchPaperResult[];
	error?: string;
	cancelled?: boolean;
	overwritten?: string[];
	logTail?: string[];
}

export interface BatchDeps extends RunDeps {
	/** Must be provided when a destination exists; absence or rejection fails closed. */
	confirmOverwrite?: (targetDirs: string[]) => Promise<boolean>;
	/** Internal seam for deterministic unit tests. */
	runOne?: typeof runPipeline;
}

interface StagedPaper {
	pdfPath: string;
	title: string;
	stageDir: string;
	targetDir: string;
	tree: string[];
}

const LOG_TAIL_LIMIT = 20;

/**
 * Process PDFs into a private staging area, then publish all papers together.
 * No final destination is touched before every PDF succeeds and any overwrite
 * has been explicitly confirmed.
 */
export async function runBatchPipeline(options: BatchOptions, deps: BatchDeps = {}): Promise<BatchRunResult> {
	const validationError = validateOptions(options);
	if (validationError) return { ok: false, categoryDir: options.libraryRoot || "", papers: [], error: validationError };
	const category = safeCategory(options.category);
	const categoryDir = join(resolve(options.libraryRoot), category);

	const inputPaths = options.pdfPaths.map((path) => resolve(path));
	if (new Set(inputPaths).size !== inputPaths.length) {
		return { ok: false, categoryDir, papers: [], error: "批次中包含重复的 PDF 路径。" };
	}
	for (const path of inputPaths) {
		try {
			if (!(await stat(path)).isFile()) return { ok: false, categoryDir, papers: [], error: `不是 PDF 文件：${path}` };
		} catch {
			return { ok: false, categoryDir, papers: [], error: `PDF 不存在或无法访问：${path}` };
		}
	}

	if (deps.signal?.aborted) {
		return { ok: false, categoryDir, papers: [], cancelled: true, error: "已取消，未处理任何 PDF。" };
	}

	let stageRoot: string | undefined;
	const staged: StagedPaper[] = [];
	const logTail: string[] = [];
	const runOne = deps.runOne ?? runPipeline;
	const translationModel = options.model ?? resolveTranslationModel() ?? "MiniMax-M3.1-Flash-Preview";
	const translationBaseUrl = options.baseUrl ?? resolveTranslationBaseUrl();
	try {
		stageRoot = await mkdtemp(join(tmpdir(), "pi-paper-translator-batch-"));
		for (let index = 0; index < inputPaths.length; index++) {
			const pdfPath = inputPaths[index]!;
			const perPdfOutput = join(stageRoot, "runs", String(index + 1));
			const runOptions: Pdf2zhOptions = {
				pdfPath,
				outputRoot: perPdfOutput,
				ocr: "api",
				backend: "pipeline",
				lang: "en",
				model: translationModel,
				baseUrl: translationBaseUrl,
				workers: options.workers ?? 8,
				chunkSize: options.chunkSize ?? 3000,
				skipTranslate: false,
				force: false,
			};
			const result = await runOne(runOptions, {
				signal: deps.signal,
				onProgress: (progress) => {
					try {
						deps.onProgress?.({
							...progress,
							detail: `[${index + 1}/${inputPaths.length}] ${basename(pdfPath)}: ${progress.detail ?? progress.stage}`,
						} satisfies Progress);
					} catch { /* A UI callback must not fail the batch. */ }
				},
			});
			logTail.push(...result.logTail);
			if (!result.ok || result.skipped || !result.translatedMd) {
				const reason = result.error ?? (result.skipped ? "暂存目录意外存在同名结果" : "未生成中文 Markdown");
				throw new Error(`${basename(pdfPath)} 处理失败：${reason}`);
			}

			const markdown = await readFile(result.translatedMd, "utf8");
			const fallback = basename(pdfPath, extname(pdfPath));
			const title = paperTitleFromMarkdown(markdown, fallback);
			const names = localizedPaperNames(title);
			const finalStageDir = join(stageRoot, "papers", String(index + 1));
			await mkdir(finalStageDir, { recursive: true });
			await copyFile(result.originalPdf ?? pdfPath, join(finalStageDir, names.pdf));
			await copyFile(await findEnglishMarkdown(result.targetDir, pdfPath), join(finalStageDir, names.englishMd));
			await copyFile(result.translatedMd, join(finalStageDir, names.translatedMd));
			const imagesTarget = join(finalStageDir, IMAGES_DIR);
			if (result.imagesDir && existsSync(result.imagesDir)) {
				await cp(result.imagesDir, imagesTarget, { recursive: true, force: false, errorOnExist: true });
			} else {
				await mkdir(imagesTarget, { recursive: true });
			}
			staged.push({
				pdfPath,
				title,
				stageDir: finalStageDir,
				targetDir: join(categoryDir, title),
				tree: renderLocalizedTree(title, result.imagesDir ? await countFiles(result.imagesDir) : 0),
			});
		}

		const duplicateTitles = findDuplicates(staged.map((paper) => paper.title));
		if (duplicateTitles.length > 0) {
			throw new Error(`同一批次生成了重复的中文标题，未发布任何文件：${duplicateTitles.join("、")}`);
		}

		const existing: string[] = [];
		for (const paper of staged) {
			if (await pathExists(paper.targetDir)) existing.push(paper.targetDir);
		}
		if (existing.length > 0) {
			let confirmed = false;
			try {
				confirmed = (await deps.confirmOverwrite?.(existing)) === true;
			} catch {
				confirmed = false;
			}
			if (!confirmed) {
				await rm(stageRoot, { recursive: true, force: true });
				stageRoot = undefined;
				return {
					ok: false,
					categoryDir,
					papers: [],
					error: `目标已存在且未获得人工覆盖确认；未改动任何目标：\n${existing.map((path) => `- ${path}`).join("\n")}`,
					logTail: tailLines(logTail),
				};
			}
		}

		const committed = await publish(staged, categoryDir, stageRoot, existing);
		await rm(stageRoot, { recursive: true, force: true });
		stageRoot = undefined;
		return {
			ok: true,
			categoryDir,
			papers: staged.map(({ pdfPath, title, targetDir, tree }) => ({ pdfPath, title, targetDir, tree })),
			overwritten: committed,
			logTail: tailLines(logTail),
		};
	} catch (error) {
		if (stageRoot) await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
		return {
			ok: false,
			categoryDir,
			papers: [],
			cancelled: deps.signal?.aborted === true,
			error: error instanceof Error ? error.message : String(error),
			logTail: tailLines(logTail),
		};
	}
}

function validateOptions(options: BatchOptions): string | undefined {
	if (!Array.isArray(options.pdfPaths) || options.pdfPaths.length === 0) return "至少需要一个 PDF 文件。";
	if (!options.pdfPaths.every((path) => typeof path === "string" && path.startsWith("/"))) {
		return "每个 PDF 路径都必须是绝对路径。";
	}
	if (typeof options.category !== "string" || !options.category.trim()) return "分类目录不能为空。";
	if ([".", ".."].includes(options.category.trim())) return "分类目录不能是 . 或 ..。";
	if (typeof options.libraryRoot !== "string" || !options.libraryRoot.trim() || !options.libraryRoot.startsWith("/")) {
		return "论文库根目录必须是绝对路径。";
	}
	for (const [label, value] of [["workers", options.workers], ["chunkSize", options.chunkSize]] as const) {
		if (value !== undefined && (!Number.isInteger(value) || value <= 0)) return `${label} 必须是正整数。`;
	}
	return undefined;
}

function safeCategory(input: string): string {
	return sanitizePaperTitle(input.trim());
}

async function findEnglishMarkdown(targetDir: string, pdfPath: string): Promise<string> {
	const rawDir = join(targetDir, RAW_DIR);
	const entries = await readdir(rawDir, { withFileTypes: true });
	const markdownFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"));
	const stem = pdfStem(pdfPath);
	const chosen = markdownFiles.find((entry) => entry.name === `${stem}_en.md`)
		?? markdownFiles.find((entry) => entry.name === `${stem}.md`)
		?? markdownFiles.find((entry) => entry.name.toLowerCase() === "full.md")
		?? markdownFiles[0];
	if (!chosen) throw new Error(`MinerU 未留下英文 Markdown：${rawDir}`);
	return join(rawDir, chosen.name);
}

function findDuplicates(values: string[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) duplicates.add(value);
		seen.add(value);
	}
	return [...duplicates];
}

async function pathExists(path: string): Promise<boolean> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink()) throw new Error(`拒绝覆盖符号链接目标：${path}`);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function movePath(source: string, destination: string): Promise<void> {
	try {
		await rename(source, destination);
	} catch {
		await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
		await rm(source, { recursive: true, force: true });
	}
}

async function publish(papers: StagedPaper[], categoryDir: string, stageRoot: string, expectedExisting: string[]): Promise<string[]> {
	await mkdir(categoryDir, { recursive: true });
	const overwritten: string[] = [];
	const completed: Array<{ destination: string; backup?: string }> = [];
	const backupRoot = join(stageRoot, "backups");
	try {
		for (const [index, paper] of papers.entries()) {
			const destination = paper.targetDir;
			const destinationExists = await pathExists(destination);
			if (destinationExists && !expectedExisting.includes(destination)) {
				throw new Error(`发布期间目标目录新出现，拒绝覆盖：${destination}`);
			}
			const backup = destinationExists ? join(backupRoot, String(index + 1)) : undefined;
			if (backup) {
				await mkdir(backupRoot, { recursive: true });
				await movePath(destination, backup);
			}
			completed.push({ destination, backup });
			const pending = join(categoryDir, `.pi-paper-translator-pending-${process.pid}-${index}-${Date.now()}`);
			try {
				await cp(paper.stageDir, pending, { recursive: true, force: false, errorOnExist: true });
				await rename(pending, destination);
			} catch (error) {
				await rm(pending, { recursive: true, force: true });
				throw error;
			}
			if (backup) overwritten.push(destination);
		}
		return overwritten;
	} catch (error) {
		const rollbackErrors: string[] = [];
		for (const item of completed.reverse()) {
			try {
				await rm(item.destination, { recursive: true, force: true });
			} catch (rollbackError) {
				rollbackErrors.push(`清理 ${item.destination}: ${(rollbackError as Error).message}`);
			}
			if (item.backup) {
				try {
					await movePath(item.backup, item.destination);
				} catch (rollbackError) {
					rollbackErrors.push(`恢复 ${item.destination}: ${(rollbackError as Error).message}`);
				}
			}
		}
		const rollback = rollbackErrors.length ? `；回滚也有错误：${rollbackErrors.join("；")}` : "；此前已发布的目录已回滚";
		throw new Error(`发布失败${rollback}：${(error as Error).message}`);
	}
}

async function countFiles(dir: string): Promise<number> {
	let n = 0;
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		n += entry.isDirectory() ? await countFiles(path) : 1;
	}
	return n;
}

function tailLines(lines: string[]): string[] {
	return lines.slice(-LOG_TAIL_LIMIT);
}
