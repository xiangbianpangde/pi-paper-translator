/**
 * Pure argument parsing for the /pdf2zh command.
 *
 * Kept free of node/pi imports so it can be unit-tested in isolation.
 */
import { dirname, isAbsolute, resolve } from "node:path";
import type { OcrMode, Pdf2zhOptions } from "./types.ts";

export const HELP_TEXT = [
	"/pdf2zh <pdf_path> [options]",
	"",
	"把英文 PDF 翻译成中文 Markdown，输出到源 PDF 同级的 <论文名>/ 子目录：",
	"  <论文名>/<论文名>_zh.md   翻译后的 Markdown",
	"  <论文名>/images/          抽取的图片（md 内为相对引用，可直接预览）",
	"  <论文名>/<原文件名>.pdf   原 PDF 副本",
	"  <论文名>/_raw/            英文原版 md + MinerU 副产物（可删）",
	"",
	"选项:",
	"  -o, --output-dir <dir>   输出根目录（默认：源 PDF 所在目录）",
	"  -b, --backend <name>     --ocr local 时的 mineru backend（默认 pipeline）",
	"  -l, --lang <code>        OCR 语言提示（默认 en）",
	"      --ocr <api|local>    OCR 模式（默认 api = MinerU 云 API）",
	"      --model <name>       翻译模型（默认 MiniMax-M3；可由用户配置覆盖）",
	"      --base-url <url>     OpenAI 兼容翻译接口地址（可由用户配置覆盖）",
	"      --workers <n>        翻译并发数（默认 8）",
	"      --chunk-size <n>     翻译分块字符数（默认 3000）",
	"      --skip-translate     只做 PDF -> 英文 md，不翻译",
	"  -f, --force              覆盖已存在的输出目录，不询问",
	"  -h, --help               显示本帮助",
].join("\n");

/** Result of parsing a raw command string. */
export interface ParsedArgs {
	options?: Pdf2zhOptions;
	/** Set when help was requested. */
	help?: boolean;
	/** Set when parsing failed; already phrased for direct display. */
	error?: string;
	/** True when --model was explicitly supplied. */
	modelSpecified?: boolean;
	/** Non-fatal notes, e.g. a relative path being resolved against cwd. */
	warnings?: string[];
}

const OCR_MODES: readonly string[] = ["api", "local"];

/** Flags that consume the following token as their value. */
const VALUE_FLAGS = new Set([
	"-o",
	"--output-dir",
	"-b",
	"--backend",
	"-l",
	"--lang",
	"--ocr",
	"--model",
	"--base-url",
	"--workers",
	"--chunk-size",
]);

/** Flags that take no value. */
const BOOL_FLAGS = new Set(["--skip-translate", "-f", "--force", "-h", "--help"]);

function toPositiveInt(raw: string, flag: string, fallback: number): { value: number } | { error: string } {
	if (!/^\d+$/.test(raw)) return { error: `${flag} 需要正整数，收到 "${raw}"` };
	const n = Number.parseInt(raw, 10);
	if (n <= 0) return { error: `${flag} 需要正整数，收到 "${raw}"` };
	return { value: n };
}

/**
 * Parse the raw argument string of `/pdf2zh`.
 *
 * `cwd` anchors relative paths. Only the first positional token is treated as
 * the PDF path; unknown flags are reported rather than silently passed through,
 * so a typo cannot quietly change the output layout.
 */
export function parseArgs(raw: string, cwd: string): ParsedArgs {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { error: "缺少 PDF 路径。用法：/pdf2zh <pdf_path> [选项]" };

	const warnings: string[] = [];
	let pdfPath: string | undefined;
	let outputRoot: string | undefined;
	let ocr: OcrMode = "api";
	let backend = "pipeline";
	let lang = "en";
	let model = "MiniMax-M3";
	let modelSpecified = false;
	let baseUrl: string | undefined;
	let workers = 8;
	let chunkSize = 3000;
	let skipTranslate = false;
	let force = false;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token === "-h" || token === "--help") return { help: true };

		if (VALUE_FLAGS.has(token)) {
			const next = tokens[++i];
			if (next === undefined) return { error: `${token} 缺少取值` };
			switch (token) {
				case "-o":
				case "--output-dir":
					outputRoot = next;
					break;
				case "-b":
				case "--backend":
					backend = next;
					break;
				case "-l":
				case "--lang":
					lang = next;
					break;
				case "--ocr":
					if (!OCR_MODES.includes(next)) {
						return { error: `--ocr 只支持 ${OCR_MODES.join(" | ")}，收到 "${next}"` };
					}
					ocr = next as OcrMode;
					break;
				case "--model":
					model = next;
					modelSpecified = true;
					break;
				case "--base-url":
					baseUrl = next;
					break;
				case "--workers": {
					const parsed = toPositiveInt(next, token, workers);
					if ("error" in parsed) return { error: parsed.error };
					workers = parsed.value;
					break;
				}
				case "--chunk-size": {
					const parsed = toPositiveInt(next, token, chunkSize);
					if ("error" in parsed) return { error: parsed.error };
					chunkSize = parsed.value;
					break;
				}
			}
			continue;
		}

		if (BOOL_FLAGS.has(token)) {
			if (token === "--skip-translate") skipTranslate = true;
			if (token === "-f" || token === "--force") force = true;
			continue;
		}

		if (token.startsWith("-")) return { error: `未知选项 "${token}"。用 /pdf2zh --help 查看用法` };

		if (pdfPath === undefined) {
			pdfPath = token;
		} else {
			return { error: `多余的位置参数 "${token}"（只接受一个 PDF 路径）` };
		}
	}

	if (pdfPath === undefined) return { error: "缺少 PDF 路径。用法：/pdf2zh <pdf_path> [选项]" };

	const resolveMaybe = (p: string): string => (isAbsolute(p) ? p : resolve(cwd, p));
	if (!isAbsolute(pdfPath)) warnings.push(`相对路径按当前工作目录解析：${pdfPath} -> ${resolve(cwd, pdfPath)}`);
	if (outputRoot !== undefined && !isAbsolute(outputRoot)) {
		warnings.push(`输出目录按当前工作目录解析：${outputRoot} -> ${resolve(cwd, outputRoot)}`);
	}

	const absolutePdf = resolveMaybe(pdfPath);
	// Default: a <stem>/ subdirectory beside the source PDF.
	const root = outputRoot !== undefined ? resolveMaybe(outputRoot) : dirname(absolutePdf);

	return {
		options: {
			pdfPath: absolutePdf,
			outputRoot: root,
			ocr,
			backend,
			lang,
			model,
			baseUrl,
			workers,
			chunkSize,
			skipTranslate,
			force,
		},
		warnings,
		modelSpecified,
	};
}
