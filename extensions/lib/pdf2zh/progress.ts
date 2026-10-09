/**
 * Pure parsing of the pdf2zh pipeline's log stream.
 *
 * The python scripts log through `logging` with format
 * `"%(asctime)s %(levelname)s %(message)s"` and `datefmt="%H:%M:%S"`, so lines
 * look like `21:11:03 INFO [1/2] PDF -> Markdown (ocr=api)`. Retry warnings are
 * printed raw to stderr by translate_md.py. Both shapes are handled here.
 */
import type { Progress } from "./types.ts";

const TIMESTAMP = /^\d{2}:\d{2}:\d{2}\s+(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+(.*)$/;
/** `[37/120] chunk #5 ok` and the `[1/2]` stage markers both use this shape. */
const COUNTER = /\[(\d+)\/(\d+)\]/;
/** `batch_id=...` / `Uploading xxx (3.2 MB)` style detail lines. */
const CHUNK_TOTAL = /^(\d+)\s+chunks$/;

/** Strip the logging prefix, leaving just the message. */
export function stripLogPrefix(line: string): string {
	const m = TIMESTAMP.exec(line.trimEnd());
	return (m?.[2] ?? line).trim();
}

/**
 * Map one log line to a progress event, or null when the line carries no
 * meaningful state change (so callers can skip rendering it).
 */
export function parseLogLine(line: string): Progress | null {
	const trimmed = line.trimEnd();
	if (trimmed.trim().length === 0) return null;

	const detail = stripLogPrefix(trimmed);
	const raw = trimmed;
	const counter = COUNTER.exec(detail);

	// `[1/2] PDF -> Markdown (ocr=api)` — the first stage marker.
	if (/^\[1\/2\]/.test(detail)) {
		return { stage: "ocr", detail, raw };
	}
	// `[2/2] Translating with MiniMax-M3 (workers=8)` — second stage marker.
	if (/^\[2\/2\]/.test(detail)) {
		return { stage: "translating", detail, raw };
	}
	// `12 chunks` — chunking finished, translation about to start.
	if (CHUNK_TOTAL.test(detail)) {
		return { stage: "chunking", total: Number.parseInt(CHUNK_TOTAL.exec(detail)![1]!, 10), detail, raw };
	}
	// `[37/120] chunk #5 ok` — translation progress. Total must exceed 1,
	// otherwise it is the `[1/2]`-style stage marker we already handled above.
	if (counter) {
		const done = Number.parseInt(counter[1]!, 10);
		const total = Number.parseInt(counter[2]!, 10);
		if (total > 1) return { stage: "translating", done, total, detail, raw };
	}
	if (/^Done:/.test(detail)) {
		return { stage: "finalize", detail, raw };
	}

	// Routine OCR chatter: keep it as a detail line on the current stage.
	if (TIMESTAMP.test(trimmed)) {
		return { stage: "idle", detail, raw };
	}
	return null;
}

/** Keep only the most recent `n` lines, for error reporting. */
export function tailLines(lines: string[], n: number): string[] {
	return lines.slice(Math.max(0, lines.length - n));
}

/** Render an ASCII progress bar; `ratio` is clamped to [0, 1]. */
export function progressBar(ratio: number, width = 24): string {
	const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
	const filled = Math.round(r * width);
	return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}
