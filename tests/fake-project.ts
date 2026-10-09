import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Create a tiny Python backend fixture that exercises the real Node runner offline. */
export async function createFakeProject(root: string): Promise<void> {
	const binDir = join(root, ".venv", "bin");
	await mkdir(binDir, { recursive: true });
	const python = join(binDir, "python");
	await writeFile(python, "#!/usr/bin/env bash\nexec python3 \"$@\"\n", "utf8");
	await chmod(python, 0o755);
	await writeFile(join(root, "pdf_to_zh_md.py"), `
from pathlib import Path
import os
import sys

args = sys.argv[1:]
if os.environ.get("FAKE_MODE") == "fail":
    print("fake backend failure", file=sys.stderr)
    raise SystemExit(9)
pdf = Path(args[0])
out_root = Path(args[args.index("-o") + 1])
stem = pdf.stem
target = out_root / stem
local = args[args.index("--ocr") + 1] == "local"
work = target / "auto" if local else target
work.mkdir(parents=True, exist_ok=True)
(work / "images").mkdir(exist_ok=True)
for idx in range(1, 4):
    (work / "images" / f"fig{idx}.png").write_bytes(bytes([idx, 2, 3]))
no_h1 = os.environ.get("FAKE_NO_H1") == "1"
title = os.environ.get("FAKE_TITLE") or f"论文 {stem}"
heading = "" if no_h1 else f"# {title}\\n\\n"
images = "\\n\\n".join(f"![图 {idx}](images/fig{idx}.png)" for idx in range(1, 4))
(work / f"{stem}.md").write_text(f"# {stem}\\n\\n{images}\\n", encoding="utf-8")
if "--skip-translate" not in args:
    (work / f"{stem}_zh.md").write_text(f"{heading}{images}\\n", encoding="utf-8")
(work / (f"{stem}.pdf" if stem.endswith("_layout") else f"{stem}_layout.pdf")).write_bytes(b"sidecar")
(work / f"{stem}_content_list.json").write_text("{}", encoding="utf-8")
print("[1/2] PDF -> Markdown (ocr=api)")
if "--skip-translate" not in args:
    print("[2/2] Translating with MiniMax-M3 (workers=8)")
    print("3 chunks")
    print("[1/3] chunk #1 ok")
print("Done: fake translation")
`, "utf8");
}
