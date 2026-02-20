#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_PATH="$ROOT_DIR/index.ts"

SEARCH_QUERY="${SMOKE_SEARCH_QUERY:-latest bun runtime release notes}"
FETCH_URL_OK="${SMOKE_FETCH_URL_OK:-https://example.com}"
FETCH_URL_FAIL="${SMOKE_FETCH_URL_FAIL:-https://this-domain-definitely-does-not-exist-1234567890.com}"

if ! command -v pi >/dev/null 2>&1; then
  echo "error: pi command not found in PATH" >&2
  exit 1
fi

echo "[smoke] extension: $EXT_PATH"
echo "[smoke] search query: $SEARCH_QUERY"
echo "[smoke] fetch ok url: $FETCH_URL_OK"
echo "[smoke] fetch fail url: $FETCH_URL_FAIL"
echo

echo "[1/3] gemini_web_search"
pi -e "$EXT_PATH" -p "Use gemini_web_search with query: '$SEARCH_QUERY'" || true
echo

echo "[2/3] gemini_fetch_content (expected success)"
pi -e "$EXT_PATH" -p "Use gemini_fetch_content for URL: '$FETCH_URL_OK'" || true
echo

echo "[3/3] gemini_fetch_content (expected failure path)"
pi -e "$EXT_PATH" -p "Use gemini_fetch_content for URL: '$FETCH_URL_FAIL'" || true
echo

echo "[smoke] done"
