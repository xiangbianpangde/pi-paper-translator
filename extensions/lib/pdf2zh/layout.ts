/**
 * Pure layout computation for the /pdf2zh output contract.
 *
 * Final shape (this is the contract the user asked for):
 *
 *   <outputRoot>/<stem>/
 *     ├── <stem>_zh.md      翻译后的 Markdown
 *     ├── images/           抽取的图片，md 内为相对引用
 *     ├── <原文件名>.pdf     原 PDF 副本
 *     └── _raw/             英文原版 md + MinerU 副产物
 *
 * Nothing in this module touches the filesystem; it only decides *what* each
 * produced path should be and how a name should be classified. runner.ts
 * applies the plan.
 */
import { basename, dirname, extname, join } from "node:path";

/** Subdirectory holding the English markdown and MinerU sidecars. */
export const RAW_DIR = "_raw";
/** Subdirectory holding extracted figures. */
export const IMAGES_DIR = "images";
/** Suffixes used by the Obsidian bilingual-paper layout. */
export const ENGLISH_MD_SUFFIX = "_英文.md";
export const TRANSLATED_MD_SUFFIX = "_全文翻译.md";

/** Subdirectory the local `mineru` CLI nests its output under. */
export const NESTED_DIR = "auto";

/** How a produced entry should be treated. */
export type EntryKind = "keep" | "raw" | "drop";

/** A single entry found in the output directory after the pipeline ran. */
export interface Entry {
	name: string;
	/** True when the entry is a directory. */
	isDirectory: boolean;
}

/** Classification result for one entry. */
export interface Classified {
	kind: EntryKind;
	/** File or directory name, unchanged. */
	name: string;
	/** Human-readable reason, surfaced in the report. */
	reason: string;
}

/**
 * Compute the per-PDF output directory.
 *
 * A PDF named `2608.01347.pdf` becomes `<outputRoot>/2608.01347/`, so a paper
 * keeps its identity and never collides with a same-named Markdown file.
 */
export function targetDirFor(outputRoot: string, pdfPath: string): string {
	const stem = pdfStem(pdfPath);
	return join(outputRoot, stem);
}

/** The Markdown stem for a PDF path, with or without the `.pdf` extension. */
export function pdfStem(pdfPath: string): string {
	const name = basename(pdfPath);
	const ext = extname(name);
	return ext.toLowerCase() === ".pdf" ? name.slice(0, -ext.length) : name;
}

/** The file name the original PDF should keep inside the output directory. */
export function originalPdfName(pdfPath: string): string {
	return basename(pdfPath);
}

/** The translated Markdown path the pipeline produces. */
export function translatedMdPath(targetDir: string, stem: string): string {
	return join(targetDir, `${stem}_zh.md`);
}

/** The English Markdown path produced by OCR before translation. */
export function sourceMdPath(targetDir: string, stem: string): string {
	return join(targetDir, `${stem}.md`);
}

/**
 * Decide what to do with every entry found in the output directory.
 *
 * `stem` and `originalPdfName` are passed in rather than derived, because the
 * original PDF may be named differently from the Markdown (e.g. a source file
 * called `paper v2.pdf` renamed to `paper/`).
 */
export function classifyEntries(
	entries: Entry[],
	context: { stem: string; originalPdfName: string; translated?: boolean },
): Classified[] {
	const translatedMd = `${context.stem}_zh.md`;
	const sourceMd = `${context.stem}.md`;
	const out: Classified[] = [];

	for (const entry of entries) {
		const { name, isDirectory } = entry;

		if (isDirectory) {
			if (name === IMAGES_DIR) {
				out.push({ kind: "keep", name, reason: "图片目录，md 内相对引用依赖它" });
			} else if (name === RAW_DIR) {
				out.push({ kind: "keep", name, reason: "副产物目录" });
			} else {
				out.push({ kind: "raw", name, reason: "未知子目录，归入 _raw 保持整洁" });
			}
			continue;
		}

		if (name === translatedMd) {
			out.push({ kind: "keep", name, reason: context.translated ? "翻译后的 Markdown" : "未翻译，仅英文版" });
			continue;
		}
		if (name === context.originalPdfName) {
			out.push({ kind: "keep", name, reason: "原 PDF 副本" });
			continue;
		}
		if (name === sourceMd) {
			out.push({ kind: "raw", name, reason: "英文原版 Markdown" });
			continue;
		}
		if (/\.md$/i.test(name)) {
			out.push({ kind: "raw", name, reason: "其他 Markdown（排障用）" });
			continue;
		}
		out.push({ kind: "raw", name, reason: "MinerU 副产物" });
	}
	return out;
}

/** Files MinerU emits alongside the markdown, per USAGE.md. */
export const SIDECAR_PATTERNS = [
	/_middle\.json$/i,
	/_content_list\.json$/i,
	/_layout\.pdf$/i,
	/_origin\.pdf$/i,
	/\.json$/i,
];

/** True when the name looks like a MinerU sidecar rather than a deliverable. */
export function isSidecar(name: string): boolean {
	return SIDECAR_PATTERNS.some((re) => re.test(name));
}

/**
 * Render a compact, aligned tree of the final layout.
 *
 * Shown to the user after a run, so it stays short: three deliverables plus the
 * optional raw directory, with a file count instead of every image name.
 */
export function renderTree(input: {
	stem: string;
	originalPdfName: string;
	translatedMd: boolean;
	imageCount: number;
	rawCount: number;
}): string[] {
	const lines: string[] = [`${input.stem}/`];
	lines.push(`├── ${input.stem}_zh.md${input.translatedMd ? "" : "  (缺失：未翻译或翻译失败)"}`);
	if (input.imageCount > 0) {
		lines.push(`├── ${IMAGES_DIR}/  ${input.imageCount} 个文件`);
	} else {
		lines.push(`├── ${IMAGES_DIR}/  (空：PDF 未抽取到图片)`);
	}
	const last = input.rawCount > 0;
	lines.push(`${last ? "├──" : "└──"} ${input.originalPdfName}`);
	if (last) {
		lines.push(`└── ${RAW_DIR}/  ${input.rawCount} 个文件`);
	}
	return lines;
}

/** Convert a title into a portable, single-segment filesystem name. */
export function sanitizePaperTitle(rawTitle: string, fallback = "未命名论文"): string {
	const replacements: Record<string, string> = {
		"/": "／", "\\": "＼", ":": "：", "?": "？", "*": "＊",
		'"': "＂", "<": "＜", ">": "＞", "|": "｜",
	};
	let title = rawTitle
		.normalize("NFC")
		.replace(/[\\/:?*"<>|\u0000-\u001f]/g, (ch) => replacements[ch] ?? " ")
		.replace(/[\\`]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[. ]+$/g, "");
	if (!title || title === "." || title === "..") title = fallback;
	// Leave room for the longest output suffix on filesystems with a 255-byte name limit.
	while (Buffer.byteLength(title, "utf8") > 190) title = [...title].slice(0, -1).join("");
	return title || "未命名论文";
}

/** Read the first meaningful H1 in the translated Markdown, falling back to the PDF name. */
export function paperTitleFromMarkdown(markdown: string, fallback: string): string {
	const boilerplate = new Set(["摘要", "abstract", "引言", "introduction", "目录", "contents"]);
	for (const line of markdown.split(/\r?\n/)) {
		const match = /^\s*#\s+(.+?)\s*#*\s*$/.exec(line);
		if (!match) continue;
		const candidate = match[1]!.replace(/\*\*/g, "").replace(/__/g, "").replace(/`/g, "").trim();
		if (!candidate || boilerplate.has(candidate.toLocaleLowerCase())) continue;
		return sanitizePaperTitle(candidate, fallback);
	}
	return sanitizePaperTitle(fallback);
}

/** Final file names matching the user's bilingual Obsidian-paper example. */
export function localizedPaperNames(title: string): { pdf: string; englishMd: string; translatedMd: string } {
	const safeTitle = sanitizePaperTitle(title);
	return {
		pdf: `${safeTitle}.pdf`,
		englishMd: `${safeTitle}${ENGLISH_MD_SUFFIX}`,
		translatedMd: `${safeTitle}${TRANSLATED_MD_SUFFIX}`,
	};
}

/** Compact listing of the final localized deliverables. */
export function renderLocalizedTree(title: string, imageCount: number): string[] {
	const names = localizedPaperNames(title);
	return [
		`${title}/`,
		`├── ${names.pdf}`,
		`├── ${names.englishMd}`,
		`├── ${names.translatedMd}`,
		imageCount > 0 ? `└── ${IMAGES_DIR}/  ${imageCount} 个文件` : `└── ${IMAGES_DIR}/  (空：PDF 未抽取到图片)`,
	];
}

/**
 * Decide how to flatten the local `mineru` CLI's `auto/` output directory.
 *
 * `mineru -o <dir>` writes `<dir>/<stem>/auto/<stem>.md` + `auto/images/`, while
 * the cloud API writes `<dir>/<stem>/<stem>.md` + `images/`. Without hoisting,
 * `--ocr local` would leave the deliverables one level too deep and the
 * `![](images/...)` references would break relative to the output root.
 *
 * `reserved` names already present in the target directory (notably our copy of
 * the original PDF) win every collision: the source PDF must never be clobbered
 * by a MinerU-produced file of the same name.
 */
export function planHoist(entries: Entry[], reserved: string[] = []): { move: string[]; conflict: string[] } {
	const reservedSet = new Set(reserved);
	const move: string[] = [];
	const conflict: string[] = [];
	for (const e of entries) {
		if (reservedSet.has(e.name)) conflict.push(e.name);
		else move.push(e.name);
	}
	return { move, conflict };
}

/** Convenience: the output root implied by a PDF path when none is given. */
export function defaultOutputRoot(pdfPath: string): string {
	return dirname(pdfPath);
}
