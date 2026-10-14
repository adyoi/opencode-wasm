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
# Written inline rather than through config-demo.mjs: that script reads the live
# server, and nothing is listening yet during postCreateCommand. Once the server
# is up, `node scripts/config-demo.mjs http://127.0.0.1:4096 <path>` regenerates
# it from what the server actually reports.
#
# It goes to the standard location so the server needs no environment variables.
# A machine that already runs opencode against a newer schema should point
# XDG_DATA_HOME at an empty directory instead: the server refuses to start when
# ~/.local/share/opencode/opencode.db exists but has no session table.
mkdir -p ~/.config/opencode
cat > ~/.config/opencode/opencode.json <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode/space-bunny-free",
  "permission": "allow"
}
JSON

cat <<EOF

Selesai. Jalankan server dengan:

  "$PWD/$BIN" serve \\
    --hostname 0.0.0.0 --port 4096 \\
    --cors https://adyoi.github.io

Lalu buka Ports di Codespace, set port 4096 visibility ke Public, dan pakai URL:
  https://<nama-codespace>-4096.app.github.dev

  https://adyoi.github.io/opencode-wasm/web/?server=https://<nama-codespace>-4096.app.github.dev

EOF