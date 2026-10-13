#!/usr/bin/env bash
# One-shot: init git, push to GitHub, set Pages + topics.
#
#   ./scripts/publish.sh <github-user> [repo-name]
#
# Needs `gh` authenticated (gh auth login) and a clean `npm run build`.
set -euo pipefail

USER_NAME="${1:?usage: publish.sh <github-user> [repo-name]}"
REPO="${2:-opencode-wasm}"
DESCRIPTION="OpenCode agent runtime packaged into a single WebAssembly module"

cd "$(dirname "$0")/.."

if [ ! -d .git ]; then
  git init -q -b main
fi

# Prebuilt wasm and bundled deps are ignored on purpose: CI rebuilds them.
cat > .gitignore <<'EOF'
node_modules/
rust/target/
tools/
js/dist/
web/pkg/
web/vendor/
dist/
*.log
EOF

git add -A
git commit -q -m "opencode-wasm: OpenCode runtime as a single wasm module" || true

gh repo create "$USER_NAME/$REPO" \
  --public \
  --description "$DESCRIPTION" \
  --source=. \
  --remote=origin \
  --push

# Topics (max 20, lowercase, dashes only).
# `gh repo edit --add-topic` only accepts one value per call, so use the API.
cat > /tmp/ocw-topics.json <<'JSON'
{"names":["opencode","webassembly","wasm","rust","wasm-pack","agent",
          "ai-coding-assistant","pty","xterm","github-pages","esbuild",
          "bun","browser","single-file","demo"]}
JSON
gh api -X PUT "repos/$USER_NAME/$REPO/topics" --input /tmp/ocw-topics.json >/dev/null \
  && echo "topics: ok"

# Pages is served from the GitHub Actions workflow, not a branch.
gh api -X POST "repos/$USER_NAME/$REPO/pages" \
  -f build_type=workflow 2>/dev/null || \
  echo "Pages: set manually via Settings -> Pages -> Source: GitHub Actions"

echo
echo "selesai: https://github.com/$USER_NAME/$REPO"
echo "pages  : https://$USER_NAME.github.io/$REPO/"
