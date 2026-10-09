/**
 * Orchestrates the local pdf2zh pipeline.
 *
 * Deliberately free of any pi import: this module is plain node so it can be
 * exercised by tests and reused outside the TUI.
 *
 * Sequence:
 *   1. preflight (script, python, pdf, credentials)
 *   2. create <outputRoot>/<stem>/ and copy the source PDF in  <-- before the run,
 *      so a failed OCR/translation never costs the user their original file
 *   3. spawn `.venv/bin/python pdf_to_zh_md.py <pdf> -o <outputRoot> ...`
 *      with `-o` pointing at the *parent*, because the script itself appends
 *      `<stem>/`. That makes the script's workdir identical to our targetDir,
 *      which is what keeps `![](images/...)` references valid without rewriting.
 *   4. move the English markdown and MinerU sidecars into `_raw/`
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, join } from "node:path";
import { classifyEntries, IMAGES_DIR, NESTED_DIR, originalPdfName, pdfStem, planHoist, RAW_DIR, renderTree, targetDirFor } from "./layout.ts";
import { resolveBackendDir } from "./user-config.ts";
import { parseLogLine, tailLines } from "./progress.ts";
import type { Pdf2zhOptions, Progress, RunResult } from "./types.ts";

/**
 * Root of the local pdf2zh project. The environment variable remains the
 * highest-priority override; installers store a per-user path outside the repo.
 */
export function projectDir(): string {
	return resolveBackendDir();
}
/** Entry point script. */
export function scriptPath(): string {
	return join(projectDir(), "pdf_to_zh_md.py");
}
/** Prefer the project venv so openai/tenacity resolve without activating anything. */
export function pythonPath(): string {
	return join(projectDir(), ".venv", "bin", "python");
}

const LOG_TAIL_SIZE = 30;

export interface RunDeps {
	/** Called for every parsed progress event. Must not throw. */
	onProgress?: (p: Progress) => void;
	signal?: AbortSignal;
}

/** Fail fast with an actionable message instead of a python traceback. */
export async function preflight(opts: Pdf2zhOptions): Promise<string | undefined> {
	if (!existsSync(scriptPath())) {
		return `找不到管线脚本 ${scriptPath()}\n请先运行 Pi Paper Translator 安装脚本，或设置 PDF2ZH_PROJECT_DIR。`;
	}
	if (!existsSync(pythonPath())) {
		return `找不到 python 解释器 ${pythonPath()}\n请运行 Pi Paper Translator 安装脚本以创建 API 模式所需的 Python 环境。`;
	}
	if (!existsSync(opts.pdfPath)) return `PDF 不存在：${opts.pdfPath}`;
	const s = await stat(opts.pdfPath);
	if (!s.isFile()) return `不是文件：${opts.pdfPath}`;
	if (!s.size) return `PDF 是空文件（0 字节）：${opts.pdfPath}`;
	return undefined;
}

/** True when a previous run already produced the translated markdown. */
export async function alreadyTranslated(targetDir: string, stem: string): Promise<boolean> {
	return existsSync(join(targetDir, `${stem}_zh.md`));
}

/** Build the argument vector handed to python. Exported for testing. */
export function buildArgs(opts: Pdf2zhOptions): string[] {
	const args = [scriptPath(), opts.pdfPath, "-o", opts.outputRoot, "--ocr", opts.ocr, "-b", opts.backend, "-l", opts.lang, "--model", opts.model, "--workers", String(opts.workers), "--chunk-size", String(opts.chunkSize)];
	if (opts.skipTranslate) args.push("--skip-translate");
	return args;
}

/** Count files (recursively) in a directory. Returns 0 when it does not exist. */
async function countFiles(dir: string): Promise<number> {
	if (!existsSync(dir)) return 0;
	let n = 0;
	for (const e of await readdir(dir, { withFileTypes: true })) {
		if (e.isDirectory()) n += await countFiles(join(dir, e.name));
		else n++;
	}
	return n;
}

/** Move a file or directory, falling back to copy+delete across devices. */
async function movePath(from: string, to: string): Promise<void> {
	if (existsSync(to)) await rm(to, { recursive: true, force: true });
	try {
		await rename(from, to);
	} catch {
		// rename() cannot cross devices; `cp` handles both files and directories.
		await cp(from, to, { recursive: true });
		await rm(from, { recursive: true, force: true });
	}
}

/**
 * Hoist `auto/` (the local `mineru` CLI's output nesting) up to targetDir.
 *
 * A no-op for the default cloud-API path, which already writes beside the
 * markdown. Collisions favour what is already in targetDir — above all our copy
 * of the original PDF, which must never be overwritten.
 */
async function flattenNestedDir(targetDir: string, originalName: string): Promise<string[]> {
	const nested = join(targetDir, NESTED_DIR);
	if (!existsSync(nested)) return [];
	const entries = await readdir(nested, { withFileTypes: true });
	const names = entries.map((e) => e.name);
	const existing = new Set((await readdir(targetDir, { withFileTypes: true })).map((e) => e.name));
	const { move, conflict } = planHoist(
		entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() })),
		[originalName, ...names.filter((n) => existing.has(n))],
	);
	for (const name of move) await movePath(join(nested, name), join(targetDir, name));
	await rm(nested, { recursive: true, force: true });
	return conflict;
}

/** Move every `raw`-classified entry into `_raw/`, leaving the 3 deliverables on top. */
async function archiveSidecars(targetDir: string, originalName: string, stem: string, translated: boolean): Promise<{ rawCount: number }> {
	const entries = await readdir(targetDir, { withFileTypes: true });
	const classified = classifyEntries(
		entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() })),
		{ stem, originalPdfName: originalName, translated },
	);

	const movers = classified.filter((c) => c.kind === "raw");
	if (movers.length === 0) return { rawCount: 0 };

	const rawDir = join(targetDir, RAW_DIR);
	await mkdir(rawDir, { recursive: true });
	for (const m of movers) {
		await movePath(join(targetDir, m.name), join(rawDir, m.name));
	}
	return { rawCount: await countFiles(rawDir) };
}

/**
 * Run the full pipeline.
 *
 * Never throws for a pipeline failure: failures come back as `{ ok: false }` with
 * a log tail, so the caller can render the state of the output directory.
 */
export async function runPipeline(opts: Pdf2zhOptions, deps: RunDeps = {}): Promise<RunResult> {
	const stem = pdfStem(opts.pdfPath);
	const targetDir = targetDirFor(opts.outputRoot, opts.pdfPath);
	const originalName = originalPdfName(opts.pdfPath);
	const logLines: string[] = [];
	const push = (p: Progress) => {
		if (p.raw) logLines.push(p.raw);
		deps.onProgress?.(p);
	};

	const preflightError = await preflight(opts);
	if (preflightError) {
		return { ok: false, targetDir, tree: [], logTail: [], error: preflightError };
	}

	if (!opts.force && (await alreadyTranslated(targetDir, stem))) {
		return {
			ok: true,
			targetDir,
			skipped: true,
			tree: [`${stem}/  (已存在，未覆盖。加 --force 重新翻译)`],
			logTail: [],
		};
	}

	// A stale directory makes MinerU's `extractall` merge with old files.
	if (opts.force && existsSync(targetDir)) await rm(targetDir, { recursive: true, force: true });
	await mkdir(targetDir, { recursive: true });

	// 2. Copy the original in first: the PDF is the one artifact we must not lose.
	const pdfCopy = join(targetDir, originalName);
	await copyFile(opts.pdfPath, pdfCopy);
	push({ stage: "prepare", detail: `已复制原 PDF → ${basename(pdfCopy)}` });

	// 3. Spawn the pipeline, streaming both pipes.
	push({ stage: "ocr", detail: `启动 ${basename(pythonPath())} ${basename(scriptPath())}` });

	const exitCode = await new Promise<number | null>((resolve) => {
		const child = spawn(pythonPath(), buildArgs(opts), { cwd: projectDir(), stdio: ["ignore", "pipe", "pipe"] });

		const pump = (stream: NodeJS.ReadableStream) => {
			const rl = createInterface({ input: stream, crlfDelay: Infinity });
			rl.on("line", (line) => {
				const p = parseLogLine(line);
				if (p) push(p);
				else if (line.trim()) logLines.push(line);
			});
		};
		pump(child.stdout);
		pump(child.stderr);

		child.on("error", (err) => {
			logLines.push(`spawn error: ${err.message}`);
			resolve(null);
		});
		child.on("close", (code) => resolve(code));

		if (deps.signal) {
			if (deps.signal.aborted) child.kill("SIGTERM");
			else deps.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
		}
	});

	const cancelled = deps.signal?.aborted === true;

	// 4. Flatten the local mineru `auto/` nesting FIRST, so the deliverables sit
	//    at targetDir root and only then judge what is a deliverable vs a sidecar.
	let rawCount = 0;
	const conflicts: string[] = [];
	try {
		conflicts.push(...(await flattenNestedDir(targetDir, originalName)));
	} catch (err) {
		logLines.push(`整理 auto/ 目录失败: ${(err as Error).message}`);
	}

	const zhPath = join(targetDir, `${stem}_zh.md`);
	const translated = existsSync(zhPath);

	try {
		({ rawCount } = await archiveSidecars(targetDir, originalName, stem, translated));
	} catch (err) {
		logLines.push(`归置副产物失败: ${(err as Error).message}`);
	}
	for (const c of conflicts) logLines.push(`auto/ 下的 ${c} 与已有文件同名，已保留已有文件`);

	const imageCount = await countFiles(join(targetDir, IMAGES_DIR));
	const tree = renderTree({ stem, originalPdfName: originalName, translatedMd: translated, imageCount, rawCount });

	if (cancelled) {
		return { ok: false, targetDir, tree, logTail: tailLines(logLines, LOG_TAIL_SIZE), cancelled: true, error: "已取消" };
	}
	if (exitCode !== 0) {
		return {
			ok: false,
			targetDir,
			originalPdf: existsSync(pdfCopy) ? pdfCopy : undefined,
			translatedMd: translated ? zhPath : undefined,
			tree,
			logTail: tailLines(logLines, LOG_TAIL_SIZE),
			error: `管线退出码 ${exitCode}`,
		};
	}
	return {
		ok: true,
		targetDir,
		originalPdf: existsSync(pdfCopy) ? pdfCopy : undefined,
		translatedMd: translated ? zhPath : undefined,
		imagesDir: existsSync(join(targetDir, IMAGES_DIR)) ? join(targetDir, IMAGES_DIR) : undefined,
		rawDir: rawCount > 0 ? join(targetDir, RAW_DIR) : undefined,
		tree,
		logTail: tailLines(logLines, LOG_TAIL_SIZE),
	};
}
