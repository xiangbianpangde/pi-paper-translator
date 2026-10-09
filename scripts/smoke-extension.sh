#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PI_BIN="${PI_BIN:-pi}"
if ! command -v "$PI_BIN" >/dev/null 2>&1; then
  echo "Pi CLI not found; set PI_BIN or install Pi before running the extension smoke check." >&2
  exit 2
fi

output="$(mktemp)"
trap 'rm -f "$output"' EXIT
"$PI_BIN" -ne -e "$ROOT/extensions/pdf2zh.ts" --help >"$output" 2>&1 || {
  cat "$output" >&2
  exit 1
}
if grep -Eqi 'failed to load extension|error loading extension|cannot find (module|package)|module not found|ERR_MODULE_NOT_FOUND' "$output"; then
  cat "$output" >&2
  exit 1
fi
printf 'Pi loaded %s successfully.\n' "$ROOT/extensions/pdf2zh.ts"
