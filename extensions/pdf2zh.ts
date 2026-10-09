/**
 * /pdf2zh — translate an English PDF into Chinese Markdown.
 *
 * Thin orchestration layer over the local project at ~/Projects/pdf2zh
 * (MinerU cloud OCR + configured OpenAI-compatible translation model). All real work lives in
 * lib/pdf2zh/; this file only wires the command, the LLM tool and the TUI view.
 *
 * Output contract — a sibling directory of the source PDF:
 *
 *   <paper>/
 *     ├── <paper>_zh.md    translated markdown
 *     ├── images/           figures, referenced relatively from the markdown
 *     ├── <original>.pdf   copy of the source PDF
 *     └── _raw/             English markdown + MinerU sidecars
 */
import { basename, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runBatchPipeline, type BatchRunResult } from "./lib/pdf2zh/batch.ts";
import { HELP_TEXT, parseArgs } from "./lib/pdf2zh/args.ts";
import { runPipeline } from "./lib/pdf2zh/runner.ts";
import type { Pdf2zhOptions, RunResult } from "./lib/pdf2zh/types.ts";
import { resolveLibraryRoot, resolveTranslationBaseUrl, resolveTranslationModel } from "./lib/pdf2zh/user-config.ts";
import { Pdf2zhProgressView } from "./lib/pdf2zh/view.ts";

/** Render the final layout for display. */
function report(result: RunResult): string {
	if (result.error && result.tree.length === 0) return `pdf2zh 失败：${result.error}`;
	const lines = [result.error ? `⚠️ ${result.error}` : "", `${result.targetDir}/`, ...result.tree.map((l) => "  " + l)];
	if (result.logTail.length > 0 && result.error) {
		lines.push("", "日志尾部：", ...result.logTail.slice(-8).map((l) => "  " + l));
	}
	return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

function reportBatch(result: BatchRunResult): string {
	if (!result.ok) {
		const logs = result.logTail?.length ? `\n\n日志尾部：\n${result.logTail.slice(-8).map((line) => `  ${line}`).join("\n")}` : "";
		return `批量论文处理失败：${result.error ?? "未知错误"}${logs}`;
	}
	const lines = [`完成 ${result.papers.length} 篇论文 → ${result.categoryDir}/`];
	for (const paper of result.papers) lines.push("", `${paper.targetDir}/`, ...paper.tree.slice(1).map((line) => `  ${line}`));
	if (result.overwritten?.length) lines.push("", `已按确认覆盖 ${result.overwritten.length} 个目录。`);
	return lines.join("\n");
}

/** Run the pipeline behind a live TUI view. */
async function runWithView(opts: Pdf2zhOptions, ctx: ExtensionContext): Promise<RunResult | null> {
	return ctx.ui.custom<RunResult | null>((tui, theme, _keybindings, done) => {
		const view = new Pdf2zhProgressView(tui, theme);
		view.onAbort = () => done(null);
		void runPipeline(opts, { onProgress: (p) => view.update(p), signal: view.signal })
			.then((r) => {
				view.finish(r.ok ? "done" : "failed");
				// Let the final frame paint before the view is torn down.
				setTimeout(() => done(r), 120);
			})
			.catch((err: unknown) => {
				if (view.signal.aborted) return done(null);
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
				done(null);
			});
		return view;
	});
}

/** Run headless (RPC / print modes) and report progress through the footer. */
async function runHeadless(opts: Pdf2zhOptions, ctx: ExtensionContext): Promise<RunResult | null> {
	ctx.ui.setStatus("pdf2zh", `${basename(opts.pdfPath)} 翻译中…`);
	try {
		return await runPipeline(opts, {
			signal: ctx.signal,
			onProgress: (p) => {
				const c = p.done !== undefined && p.total !== undefined ? ` ${p.done}/${p.total}` : "";
				ctx.ui.setStatus("pdf2zh", `${p.detail ?? p.stage}${c}`);
			},
		});
	} finally {
		ctx.ui.setStatus("pdf2zh", undefined);
	}
}

export default function (pi: ExtensionAPI) {
	// ---------------------------------------------------------------- command
	pi.registerCommand("pdf2zh", {
		description: "把英文 PDF 翻译成中文 Markdown（输出 <论文名>/_zh.md + images/ + 原 PDF）",
		handler: async (args, ctx) => {
			let raw = args.trim();
			if (raw.length === 0) {
				raw = ((await ctx.ui.editor("/pdf2zh — PDF 路径")) ?? "").trim();
				if (raw.length === 0) {
					ctx.ui.notify("已取消。用法：/pdf2zh <pdf_path> [选项]", "info");
					return;
				}
			}

			const parsed = parseArgs(raw, ctx.cwd);
			if (parsed.help) {
				ctx.ui.notify(HELP_TEXT, "info");
				return;
			}
			if (parsed.error || !parsed.options) {
				ctx.ui.notify(parsed.error ?? "参数错误", "error");
				return;
			}
			for (const w of parsed.warnings ?? []) ctx.ui.notify(w, "warning");

			const opts = parsed.options;
			if (!parsed.modelSpecified) opts.model = resolveTranslationModel() ?? opts.model;
			opts.baseUrl ??= resolveTranslationBaseUrl();
			const result = ctx.mode === "tui" ? await runWithView(opts, ctx) : await runHeadless(opts, ctx);
			if (result === null) {
				ctx.ui.notify("已取消", "info");
				return;
			}
			if (result.skipped) {
				ctx.ui.notify(`${result.tree[0] ?? ""}`, "warning");
				return;
			}
			ctx.ui.notify(report(result), result.ok ? "info" : "error");
		},
	});

	// ------------------------------------------------------------------ tool
	pi.registerTool({
		name: "pdf_translate",
		label: "PDF 翻译",
		description: [
			"把英文 PDF 翻译成中文 Markdown，调用本地 pdf2zh 项目（MinerU 云 OCR + 用户配置的 OpenAI 兼容翻译模型）。",
			"在源 PDF 同级生成 <论文名>/ 子目录，内含翻译后的 <论文名>_zh.md、images/（md 内为相对引用）、原 PDF 副本，以及 _raw/（英文原版 md 与 MinerU 副产物，可删）。",
			"首次调用前建议先向用户确认 PDF 路径；一次完整运行通常需要数分钟。",
		].join("\n"),
		promptSnippet: "pdf_translate: 英文 PDF → 中文 Markdown（<论文名>/_zh.md + images/ + 原 PDF）",
		parameters: Type.Object({
			pdfPath: Type.String({ description: "英文 PDF 的绝对路径" }),
			outputDir: Type.Optional(
				Type.String({ description: "输出根目录；生成的 <论文名>/ 放在其下。默认与源 PDF 同级" }),
			),
			ocr: Type.Optional(Type.Union([Type.Literal("api"), Type.Literal("local")], { description: "OCR 模式，默认 api（MinerU 云 API）" })),
			model: Type.Optional(Type.String({ description: "翻译模型；默认使用用户配置或 MiniMax-M3" })),
			baseUrl: Type.Optional(Type.String({ description: "OpenAI 兼容翻译接口地址；默认使用用户配置" })),
			workers: Type.Optional(Type.Number({ description: "翻译并发数，默认 8" })),
			chunkSize: Type.Optional(Type.Number({ description: "翻译分块字符数，默认 3000" })),
			skipTranslate: Type.Optional(Type.Boolean({ description: "只做 PDF → 英文 md，不翻译，默认 false" })),
			force: Type.Optional(Type.Boolean({ description: "覆盖已存在的输出目录，默认 false" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const options: Pdf2zhOptions = {
				pdfPath: params.pdfPath,
				outputRoot: params.outputDir ?? dirname(params.pdfPath),
				ocr: params.ocr ?? "api",
				backend: "pipeline",
				lang: "en",
				model: params.model ?? resolveTranslationModel() ?? "MiniMax-M3",
				baseUrl: params.baseUrl ?? resolveTranslationBaseUrl(),
				workers: params.workers ?? 8,
				chunkSize: params.chunkSize ?? 3000,
				skipTranslate: params.skipTranslate ?? false,
				force: params.force ?? false,
			};
			if (!options.pdfPath.startsWith("/")) {
				return {
					content: [{ type: "text" as const, text: `pdfPath 必须是绝对路径：${options.pdfPath}` }],
					isError: true,
					details: { error: "relative-pdf-path" },
				};
			}

			const result = await runPipeline(options, {
				signal: signal ?? undefined,
				onProgress: (p) => {
					const c = p.done !== undefined && p.total !== undefined ? ` ${p.done}/${p.total}` : "";
					onUpdate?.({
						content: [{ type: "text", text: `${p.stage}${c} ${p.detail ?? ""}` }],
						details: { stage: p.stage, done: p.done, total: p.total },
					});
				},
			});

			return {
				content: [{ type: "text" as const, text: report(result) }],
				isError: !result.ok,
				details: {
					ok: result.ok,
					targetDir: result.targetDir,
					translatedMd: result.translatedMd ?? null,
					originalPdf: result.originalPdf ?? null,
					imagesDir: result.imagesDir ?? null,
					rawDir: result.rawDir ?? null,
					skipped: result.skipped ?? false,
					error: result.error ?? null,
				},
			};
		},
	});

	// --------------------------------------------------------- batch agent tool
	pi.registerTool({
		name: "pdf_translate_batch",
		label: "批量整理论文",
		description: [
			"批量处理多个本地英文 PDF：MinerU 云 API OCR + 用户配置的 OpenAI 兼容模型全文翻译。",
			"同一批次的论文写入论文库根目录下同一个分类目录；每篇目录和文件前缀取中文 Markdown 的一级标题，缺失时回退 PDF 文件名。",
			"每篇输出原 PDF、_英文.md、_全文翻译.md 和 images/。图片 Markdown 相对链接保持有效。",
			"开始前请确认用户提供的 PDF 路径、分类名与论文库根目录。目标存在时会弹出人工覆盖确认；无 UI 时拒绝覆盖。",
		].join("\n"),
		promptSnippet: "批量 MinerU OCR + 配置模型翻译多篇 PDF，并按 Obsidian 中文论文目录整理。",
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		parameters: Type.Object({
			pdfPaths: Type.Array(Type.String({ description: "本地 PDF 的绝对路径" }), {
				minItems: 1,
				description: "本批次处理的 PDF 绝对路径列表",
			}),
			category: Type.String({ description: "论文库根目录下的单个分类目录名，例如 02-上下文工程" }),
			libraryRoot: Type.Optional(Type.String({ description: "论文库根目录绝对路径；默认使用安装时保存的设置" })),
			model: Type.Optional(Type.String({ description: "翻译模型；默认使用用户配置或 MiniMax-M3.1-Flash-Preview" })),
			baseUrl: Type.Optional(Type.String({ description: "OpenAI 兼容翻译接口地址；默认使用用户配置" })),
			workers: Type.Optional(Type.Number({ minimum: 1, multipleOf: 1, description: "每篇论文的翻译并发数，默认 8" })),
			chunkSize: Type.Optional(Type.Number({ minimum: 1, multipleOf: 1, description: "翻译分块字符数，默认 3000" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const libraryRoot = params.libraryRoot ?? resolveLibraryRoot();
			if (!libraryRoot) {
				return {
					content: [{ type: "text" as const, text: "尚未配置论文库根目录。请先运行 scripts/setup.sh，或提供 libraryRoot 绝对路径。" }],
					isError: true,
					details: { error: "missing-library-root" },
				};
			}
			const result = await runBatchPipeline({
				pdfPaths: params.pdfPaths,
				category: params.category,
				libraryRoot,
				model: params.model ?? resolveTranslationModel() ?? "MiniMax-M3.1-Flash-Preview",
				baseUrl: params.baseUrl ?? resolveTranslationBaseUrl(),
				workers: params.workers ?? 8,
				chunkSize: params.chunkSize ?? 3000,
			}, {
				signal: signal ?? undefined,
				onProgress: (p) => onUpdate?.({
					content: [{ type: "text", text: `${p.stage}: ${p.detail ?? ""}` }],
					details: { stage: p.stage, detail: p.detail },
				}),
				confirmOverwrite: async (targets) => {
					if (!ctx.hasUI) return false;
					return ctx.ui.confirm("确认覆盖论文目录？", `以下目标已存在，确认替换整个目录？\n\n${targets.join("\n")}\n\n未确认时不会修改任何目标。`);
				},
			});
			return {
				content: [{ type: "text" as const, text: reportBatch(result) }],
				isError: !result.ok,
				details: {
					ok: result.ok,
					categoryDir: result.categoryDir,
					papers: result.papers.map(({ pdfPath, title, targetDir }) => ({ pdfPath, title, targetDir })),
					overwritten: result.overwritten ?? [],
					cancelled: result.cancelled ?? false,
					error: result.error ?? null,
				},
			};
		},
	});
}
