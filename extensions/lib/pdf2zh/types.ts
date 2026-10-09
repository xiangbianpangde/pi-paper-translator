/**
 * Shared types for the /pdf2zh translation pipeline.
 *
 * The pipeline is owned by the local project at ~/Projects/pdf2zh:
 *   MinerU 云 API (OCR)  ->  <stem>.md  +  images/
 *   MiniMax-M3 (翻译)    ->  <stem>_zh.md
 *
 * This module only orchestrates that project; it never reimplements it.
 */

/** OCR backend. "api" = MinerU 云 API (default, no local model), "local" = local mineru CLI. */
export type OcrMode = "api" | "local";

/** Fully resolved run options. Produced by parseArgs, consumed by the runner. */
export interface Pdf2zhOptions {
	/** Absolute path to the source PDF. */
	pdfPath: string;
	/** Absolute path to the directory that will contain the per-PDF output subdirectory. */
	outputRoot: string;
	ocr: OcrMode;
	/** mineru backend, only meaningful when ocr === "local". */
	backend: string;
	/** OCR language hint passed to mineru, only meaningful when ocr === "local". */
	lang: string;
	/** Translation model id, e.g. "MiniMax-M3". */
	model: string;
	/** Concurrent translation requests. */
	workers: number;
	/** Max characters per translation chunk. */
	chunkSize: number;
	/** Run OCR only; do not translate. */
	skipTranslate: boolean;
	/** Overwrite an existing output directory without prompting. */
	force: boolean;
}

/** Coarse pipeline stage, derived from python log lines. */
export type Stage = "idle" | "prepare" | "ocr" | "chunking" | "translating" | "finalize" | "done" | "failed";

/** Human-readable stage label (Chinese, matches the user's working language). */
export const STAGE_LABEL: Record<Stage, string> = {
	idle: "准备中",
	prepare: "准备中",
	ocr: "OCR 解析中",
	chunking: "切分文本",
	translating: "翻译中",
	finalize: "整理产物",
	done: "完成",
	failed: "失败",
};

/** One progress event emitted while the pipeline runs. */
export interface Progress {
	stage: Stage;
	/** Completed units, when the log exposes an `n/total` counter. */
	done?: number;
	total?: number;
	/** Human-readable detail line from the pipeline log. */
	detail?: string;
	/** Raw log line, kept for the tail buffer. */
	raw?: string;
}

/** Outcome of a run. `ok: false` means the pipeline failed; partial output may still exist. */
export interface RunResult {
	ok: boolean;
	/** Absolute path of the per-PDF output directory. */
	targetDir: string;
	/** Absolute path of the translated markdown, when it exists. */
	translatedMd?: string;
	/** Absolute path of the original PDF copied into targetDir. */
	originalPdf?: string;
	/** Absolute path of the images directory, when the PDF contained extractable figures. */
	imagesDir?: string;
	/** Directory holding MinerU sidecars and the English markdown. */
	rawDir?: string;
	/** Human-readable final layout listing. */
	tree: string[];
	/** Tail of the pipeline log, for error reporting. */
	logTail: string[];
	/** Failure reason when ok is false. */
	error?: string;
	/** True when the run was aborted via the signal. */
	cancelled?: boolean;
	/** True when the run was skipped because output already existed and force was false. */
	skipped?: boolean;
}
