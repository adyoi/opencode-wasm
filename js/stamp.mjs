// Stamp cache-busting query strings into web/index.html.
//
// GitHub Pages serves assets with `Cache-Control: max-age=600`, so a browser
// keeps the previous app.js for up to ten minutes after a deploy. Pointing the
// script tags at a content hash makes every deploy take effect immediately.
//
// Run automatically by `npm run build`.
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const indexPath = join(root, "web", "index.html")

// Everything the page loads at startup.
const sources = ["web/app.js", "web/bridge.js", "web/pkg/opencode_wasm.js", "web/pkg/opencode_wasm_bg.wasm"]

const hash = createHash("sha256")
for (const file of sources) {
  hash.update(await readFile(join(root, file)))
}
const stamp = hash.digest("hex").slice(0, 8)

let html = await readFile(indexPath, "utf8")
const before = html

// Drop any previous stamp, then add the current one.
html = html.replace(/(<script type="module" src="\.\/app\.js)(\?v=[0-9a-f]+)?(")/, "$1$3")
html = html.replace(/(<script type="module" src="\.\/app\.js")/, `<script type="module" src="./app.js?v=${stamp}"`)
html = html.replace(/(\?v=)[0-9a-f]{8}(")/, `$1${stamp}$2`)

if (html === before) {
  console.log(`cache stamp up to date (${stamp})`)
} else {
  await writeFile(indexPath, html, "utf8")
  console.log(`stamped index.html with v=${stamp}`)
}
