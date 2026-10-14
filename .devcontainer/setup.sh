#!/usr/bin/env bash
# One-shot setup for a Codespace (or any Linux box) that will host the opencode
# server for the demo at https://adyoi.github.io/opencode-wasm/
#
# What it does:
#   1. installs the published opencode CLI
#   2. writes a config: free model by default, tools allowed
#   3. prints the exact command to start the server
#
# Older revisions installed `opencode-ai@dev` and then rewrote the version baked
# into the binary, because dev snapshots report 0.0.0-dev-* and the free tier
# gateway answers HTTP 426 for anything below 1.18.0. That workaround is gone:
# the published release already reports a version the gateway accepts, so
# scripts/patch-version.mjs has nothing left to patch.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> 1/2  install the opencode CLI"
npm install opencode-ai@latest --no-save --prefix tools/opencode-dev
BIN="tools/opencode-dev/node_modules/opencode-ai/bin/opencode"
"$BIN" --version

echo "==> 2/2  write the demo config"
mkdir -p tools/xdg-config/opencode
node scripts/config-demo.mjs http://127.0.0.1:4096 tools/xdg-config/opencode/opencode.json || {
  echo "  (server belum jalan — config akan dibuat ulang nanti oleh config-demo.mjs)"
}

echo
echo "Selesai. Jalankan server dengan:"
echo
echo '  "$PWD/'"$BIN"'" serve \'
echo '    --hostname 0.0.0.0 --port 4096 \'
echo '    --cors https://adyoi.github.io'
echo
echo "Lalu buka Ports di Codespace, set port 4096 visibility ke Public, dan pakai URL:"
echo "  https://<nama-codespace>-4096.app.github.dev"
echo
echo "  https://adyoi.github.io/opencode-wasm/web/?server=https://<nama-codespace>-4096.app.github.dev"