#!/usr/bin/env bash
set -euo pipefail

BACKEND_REPO="https://github.com/xiangbianpangde/pdf2zh.git"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
DEFAULT_BACKEND_DIR="$DATA_HOME/pi-paper-translator/pdf2zh"
DEFAULT_LIBRARY_ROOT="$HOME/Documents/Papers"
BACKEND_DIR="$DEFAULT_BACKEND_DIR"
LIBRARY_ROOT=""
NON_INTERACTIVE=0
INSTALL_PI=1

usage() {
  cat <<'USAGE'
Pi Paper Translator setup

Usage:
  scripts/setup.sh [options]

Options:
  --non-interactive       Do not prompt; require credentials in the environment.
  --backend-dir PATH      Backend clone/working directory (default: ~/.local/share/pi-paper-translator/pdf2zh).
  --library-root PATH     Obsidian paper-library root directory.
  --no-pi-install         Configure backend and secrets without running `pi install`.
  -h, --help              Show this help.

Credentials are read only from the environment in non-interactive mode:
  MINERU_TOKEN
  MINIMAX_API_KEY

Do not pass credentials as command-line arguments. They are stored in the backend's
ignored .secrets/ directory with owner-only permissions, never in this repository.
USAGE
}

while (($#)); do
  case "$1" in
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --backend-dir)
      [[ $# -ge 2 ]] || { echo "--backend-dir requires a path" >&2; exit 2; }
      BACKEND_DIR="$2"; shift 2 ;;
    --library-root)
      [[ $# -ge 2 ]] || { echo "--library-root requires a path" >&2; exit 2; }
      LIBRARY_ROOT="$2"; shift 2 ;;
    --no-pi-install) INSTALL_PI=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

expand_path() {
  case "$1" in
    '~') printf '%s\n' "$HOME" ;;
    '~/'*) printf '%s/%s\n' "$HOME" "${1#~/}" ;;
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$PWD" "$1" ;;
  esac
}

BACKEND_DIR="$(expand_path "$BACKEND_DIR")"
if [[ -z "$LIBRARY_ROOT" ]]; then
  if (( NON_INTERACTIVE )); then
    echo "--library-root is required with --non-interactive" >&2
    exit 2
  fi
  printf 'Obsidian 论文库根目录 [%s]: ' "$DEFAULT_LIBRARY_ROOT"
  IFS= read -r entered_root
  LIBRARY_ROOT="${entered_root:-$DEFAULT_LIBRARY_ROOT}"
fi
LIBRARY_ROOT="$(expand_path "$LIBRARY_ROOT")"

if (( ! NON_INTERACTIVE )) && { [[ -e "$BACKEND_DIR/.secrets/mineru.json" ]] || [[ -e "$BACKEND_DIR/.secrets/minimax.json" ]]; }; then
  printf 'Credential files already exist under %s/.secrets. Replace them? [y/N] ' "$BACKEND_DIR"
  IFS= read -r replace_secrets
  [[ "$replace_secrets" == "y" || "$replace_secrets" == "Y" ]] || {
    echo "Setup cancelled; existing credentials were left unchanged."
    exit 1
  }
fi

if (( ! NON_INTERACTIVE )); then
  if [[ -z "${MINERU_TOKEN:-}" ]]; then
    printf 'MinerU API token (input hidden): '
    IFS= read -r -s MINERU_TOKEN
    printf '\n'
  else
    printf 'MinerU API token is present in the environment. Press Enter to keep it, or type a replacement (hidden): '
    IFS= read -r -s entered_token
    printf '\n'
    [[ -z "$entered_token" ]] || MINERU_TOKEN="$entered_token"
  fi
  if [[ -z "${MINIMAX_API_KEY:-}" ]]; then
    printf 'MiniMax API key (input hidden): '
    IFS= read -r -s MINIMAX_API_KEY
    printf '\n'
  else
    printf 'MiniMax API key is present in the environment. Press Enter to keep it, or type a replacement (hidden): '
    IFS= read -r -s entered_key
    printf '\n'
    [[ -z "$entered_key" ]] || MINIMAX_API_KEY="$entered_key"
  fi
fi

if [[ -z "${MINERU_TOKEN:-}" || -z "${MINIMAX_API_KEY:-}" ]]; then
  echo "Both MINERU_TOKEN and MINIMAX_API_KEY are required." >&2
  exit 2
fi
export MINERU_TOKEN MINIMAX_API_KEY

command -v git >/dev/null || { echo "git is required." >&2; exit 1; }
command -v node >/dev/null || { echo "Node.js is required to write the private configuration files." >&2; exit 1; }
command -v python3 >/dev/null || { echo "Python 3.10+ is required." >&2; exit 1; }
python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' || {
  echo "Python 3.10 or newer is required." >&2
  exit 1
}

if [[ -d "$BACKEND_DIR" ]]; then
  if [[ ! -f "$BACKEND_DIR/pdf_to_zh_md.py" || ! -f "$BACKEND_DIR/config.py" ]]; then
    echo "Backend path exists but is not a pdf2zh checkout: $BACKEND_DIR" >&2
    exit 1
  fi
  echo "Using existing pdf2zh checkout: $BACKEND_DIR"
else
  mkdir -p "$(dirname "$BACKEND_DIR")"
  git clone --depth 1 "$BACKEND_REPO" "$BACKEND_DIR"
fi
if ! git -C "$BACKEND_DIR" check-ignore -q -- .secrets/mineru.json; then
  echo "Refusing to store credentials: .secrets is not ignored by the backend Git checkout." >&2
  exit 1
fi

if [[ ! -x "$BACKEND_DIR/.venv/bin/python" ]]; then
  python3 -m venv "$BACKEND_DIR/.venv"
fi
"$BACKEND_DIR/.venv/bin/python" -m pip install --upgrade pip
"$BACKEND_DIR/.venv/bin/python" -m pip install -r "$(cd "$(dirname "$0")/.." && pwd)/requirements-api.txt"

umask 077
SECRETS_DIR="$BACKEND_DIR/.secrets"
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
export PI_PAPER_TRANSLATOR_BACKEND_DIR="$BACKEND_DIR"
export PI_PAPER_TRANSLATOR_LIBRARY_ROOT="$LIBRARY_ROOT"
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const secretsDir = process.env.PI_PAPER_TRANSLATOR_BACKEND_DIR + '/.secrets';
const files = [
  ['mineru.json', { token: process.env.MINERU_TOKEN }],
  ['minimax.json', { key: process.env.MINIMAX_API_KEY }],
];
for (const [name, value] of files) {
  const target = path.join(secretsDir, name);
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(target, 0o600);
}

const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const configDir = path.join(configHome, 'pi-paper-translator');
fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
const explicitConfigPath = process.env.PI_PAPER_TRANSLATOR_CONFIG;
const configPath = explicitConfigPath
  ? path.resolve(explicitConfigPath.replace(/^~(?=\/|$)/, os.homedir()))
  : path.join(configDir, 'config.json');
fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
let prior = {};
try { prior = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const config = {
  ...prior,
  backendDir: process.env.PI_PAPER_TRANSLATOR_BACKEND_DIR,
  libraryRoot: process.env.PI_PAPER_TRANSLATOR_LIBRARY_ROOT,
};
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
fs.chmodSync(configPath, 0o600);
NODE
unset MINERU_TOKEN MINIMAX_API_KEY entered_token entered_key

if (( INSTALL_PI )); then
  if command -v pi >/dev/null; then
    pi install git:github.com/xiangbianpangde/pi-paper-translator
  else
    echo "Pi CLI not found; backend and credentials are configured. Install Pi, then run: pi install git:github.com/xiangbianpangde/pi-paper-translator" >&2
    exit 1
  fi
fi

printf '\nSetup complete.\nBackend: %s\nPaper library: %s\nCredentials: %s (mode 600)\n' \
  "$BACKEND_DIR" "$LIBRARY_ROOT" "$SECRETS_DIR"
printf 'Restart Pi, then use the pdf_translate_batch agent tool.\n'
