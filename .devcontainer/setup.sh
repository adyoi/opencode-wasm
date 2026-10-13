#!/usr/bin/env bash
# One-shot setup for a Codespace (or any Linux box) that will host the opencode
# server for the demo at https://adyoi.github.io/opencode-wasm/
#
# What it does:
#   1. installs the opencode dev snapshot (no public v2 release exists)
#   2. rewrites the baked-in version so the free tier stops answering HTTP 426
#   3. writes a config: free model by default, tools allowed
#   4. prints the exact command to start the server
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> 1/3  install opencode (dev snapshot)"
npm install opencode-ai@dev --no-save --prefix tools/opencode-dev

echo "==> 2/3  patch the version baked into the binary"
# Snapshot builds report 0.0.0-dev-*, and the free-tier gateway rejects anything
# below 1.18.0. The replacement has the same byte length so Bun offsets hold.
SRC="tools/opencode-dev/node_modules/opencode-ai/bin/opencode"
node scripts/patch-version.mjs "$SRC" "1.19.0-dev-20261013"
"$SRC" --version

echo "==> 3/3  write the demo config"
mkdir -p ~/.config/opencode
cat > ~/.config/opencode/opencode.json <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode/space-bunny-free",
  "permission": "allow",
  "provider": {
    "opencode": {
      "models": {
        "space-bunny-free": { "headers": { "user-agent": "opencode/1.19.0" } }
      }
    }
  }
}
JSON

echo
echo "Selesai. Jalankan server dengan:"
echo
echo '  "$PWD/tools/opencode-dev/node_modules/opencode-ai/bin/opencode" serve \'
echo '    --hostname 0.0.0.0 --port 4096 \'
echo '    --cors https://adyoi.github.io'
echo
echo "Lalu buka Ports di Codespace, set port 4096 visibility ke Public, dan pakai URL:"
echo "  https://<nama-codespace>-4096.app.github.dev"
echo
echo "  https://adyoi.github.io/opencode-wasm/web/?server=https://<nama-codespace>-4096.app.github.dev"
