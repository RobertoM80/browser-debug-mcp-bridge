#!/usr/bin/env bash
set -euo pipefail

REPO_PATH="${1:-$(pwd)}"

echo "[install] Using repo path: ${REPO_PATH}"

if [[ ! -f "${REPO_PATH}/package.json" ]]; then
  echo "package.json not found in ${REPO_PATH}. Run this script from repository root or pass path as first arg."
  exit 1
fi

cd "${REPO_PATH}"

echo "[install] Installing dependencies..."
pnpm install

echo "[install] Building MCP server..."
pnpm nx build mcp-server

echo "[install] Building Chrome extension..."
pnpm nx build chrome-extension

echo "[install] Printing MCP client configs..."
pnpm mcp:print-config -- --repo="${REPO_PATH}"

echo
echo "[done] Setup complete."
echo "Next:"
echo "  1) Load extension from dist/apps/chrome-extension in chrome://extensions"
echo "  2) Paste generated MCP config into your client"

