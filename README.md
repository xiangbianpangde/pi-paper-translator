# Pi Paper Translator

A Pi coding-agent package for turning one or more English research PDFs into Obsidian-ready paper folders. It reuses the public [`xiangbianpangde/pdf2zh`](https://github.com/xiangbianpangde/pdf2zh) Python pipeline: MinerU cloud OCR followed by MiniMax full-text translation.

## Output

Each PDF is staged first, then published under the same selected category:

```text
<paper-library>/<category>/<Chinese H1 title>/
├── <Chinese H1 title>.pdf
├── <Chinese H1 title>_英文.md
├── <Chinese H1 title>_全文翻译.md
└── images/
```

The first meaningful level-one heading in the translated Markdown names the folder and files. If there is no suitable H1, the original PDF filename is used. Image paths stay relative to `images/`. Papers in one batch must resolve to distinct titles; duplicate titles abort the batch. Existing destination folders require an explicit confirmation, and non-interactive runs fail closed.

## Install

### One-command interactive setup

Clone this package and run the installer:

```bash
git clone https://github.com/xiangbianpangde/pi-paper-translator.git
cd pi-paper-translator
./scripts/setup.sh
```

The setup wizard:

1. Clones the public `pdf2zh` backend into `~/.local/share/pi-paper-translator/pdf2zh` (or uses `--backend-dir`).
2. Creates a Python virtual environment and installs only the API-mode dependencies; local MinerU inference and Gradio are not installed.
3. Prompts for a paper-library root and masked MinerU/MiniMax credentials.
4. Stores credentials in the backend's ignored `.secrets/` directory (files mode `0600`) and non-secret paths in `~/.config/pi-paper-translator/config.json` (mode `0600`).
5. Runs `pi install git:github.com/xiangbianpangde/pi-paper-translator` when the Pi CLI is available.

Get a MinerU token at <https://mineru.net/apiManage/token>. Create a MiniMax API key in your MiniMax account. Do not paste credentials into source files, command-line arguments, or issue reports.

### Pi package CLI

After configuring the backend and credentials with the setup script, the package can also be installed directly by Pi:

```bash
pi install git:github.com/xiangbianpangde/pi-paper-translator
```

To try it for one invocation without adding it to settings:

```bash
pi -e git:github.com/xiangbianpangde/pi-paper-translator
```

Direct Pi package installation installs only the extension; it does not prompt for API credentials or clone/configure the Python backend. Run the setup script for those steps.

### Agent / non-interactive deployment

Supply secrets through your CI or secret manager environment (not as CLI flags), then run:

```bash
MINERU_TOKEN="$MINERU_TOKEN" MINIMAX_API_KEY="$MINIMAX_API_KEY" \
  ./scripts/setup.sh --non-interactive \
  --library-root "/absolute/path/to/Obsidian/papers"
```

You may also choose an absolute backend path:

```bash
MINERU_TOKEN="$MINERU_TOKEN" MINIMAX_API_KEY="$MINIMAX_API_KEY" \
  ./scripts/setup.sh --non-interactive \
  --backend-dir "$HOME/.local/share/pi-paper-translator/pdf2zh" \
  --library-root "$HOME/Documents/Obsidian/Papers"
```

For provisioning without the Pi CLI, add `--no-pi-install`; install the package later with `pi install <source>`. Non-interactive setup requires `--library-root`, `MINERU_TOKEN`, and `MINIMAX_API_KEY`.

## Use

Restart Pi after installation. The agent tool `pdf_translate_batch` accepts:

- `pdfPaths`: one or more local PDF absolute paths.
- `category`: one category directory shared by all PDFs, such as `02-上下文工程`.
- Optional `libraryRoot`, `model`, `workers`, and `chunkSize` overrides.

The default model is `MiniMax-M3.1-Flash-Preview`. The existing `/pdf2zh` command and `pdf_translate` single-file agent tool remain available for compatibility.

Processing is performed in a temporary staging directory. No destination is touched until all PDFs have completed and title collisions have been checked. If any destination exists, Pi asks the user before replacing it. In JSON/print modes or any context without UI, the batch is refused rather than overwriting silently.

The standalone extension can use `PDF2ZH_PROJECT_DIR` and `PI_PAPER_TRANSLATOR_LIBRARY_ROOT` environment overrides. Persistent paths are read from `~/.config/pi-paper-translator/config.json` (or `$XDG_CONFIG_HOME/pi-paper-translator/config.json`). The config stores paths only, never credentials.

## Security and privacy

- API keys are never embedded in this repository or passed by the installer as command-line arguments.
- Credentials are written to `<backend>/.secrets/mineru.json` and `<backend>/.secrets/minimax.json`; the backend repository ignores `.secrets/`.
- The installer writes secrets/config with owner-only permissions and keeps the backend clone outside the plugin checkout by default.
- PDFs are sent to MinerU and the resulting text is sent to MiniMax; use only documents you are authorized to process. Their API terms, privacy policies, quotas, and charges apply.

## Development and verification

```bash
npm install
npm test
npm run smoke:extension
```

The extension smoke check uses the installed Pi CLI to load the package entrypoint. The unit/e2e suite includes output layout, title selection, staging, image-link integrity, collision handling, and fail-closed overwrite behavior.

## Uninstall

```bash
pi remove git:github.com/xiangbianpangde/pi-paper-translator
```

This removes the Pi package registration, not the configured backend, credentials, paper library, or local checkout. Remove those separately only if you no longer need them.

## License

MIT; see [LICENSE](LICENSE).
