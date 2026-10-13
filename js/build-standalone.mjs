// Bundle the whole demo into ONE html file that runs from file://
// (double click, no web server, no node_modules on disk).
//
// What gets inlined:
//   - web/pkg/opencode_wasm_bg.wasm  as base64
//   - web/vendor/xterm.css           terminal stylesheet
//   - web/app.js                     page logic (bridge + UI + xterm), bundled
//
// The page boots with `init({ module_or_path: <bytes> })`, so there is no fetch
// of the wasm and the page origin is `null` — the opencode server must then be
// started with `--cors null`.
import { build } from "esbuild"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const outdir = join(root, "dist")
await mkdir(outdir, { recursive: true })

// 1. Bundle app.js (pulls in bridge.js and xterm) into one ESM string.
const bundled = await build({
  entryPoints: [join(root, "web", "app.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  legalComments: "none",
  outfile: join(outdir, "app.bundle.js"),
  write: false,
  logLevel: "warning",
})

const appCode = bundled.outputFiles.find((f) => f.path.endsWith(".js"))?.text ?? ""
for (const marker of ["runtimeSource", "ptyConnect", "settle"]) {
  if (!appCode.includes(marker)) throw new Error(`bundle is missing ${marker}`)
}

// xterm's stylesheet is a separate artifact, inline it too.
const xtermCss = await readFile(join(root, "web", "vendor", "xterm.css"), "utf8")

// 2. Read the wasm as base64.
const wasm = await readFile(join(root, "web", "pkg", "opencode_wasm_bg.wasm"))
const wasmBase64 = wasm.toString("base64")

// 3. Start from index.html and inline everything.
let html = await readFile(join(root, "web", "index.html"), "utf8")
const bootstrap = `globalThis.__inlineStyles = true;\nglobalThis.__wasmBytes = Uint8Array.from(atob("${wasmBase64}"), (c) => c.charCodeAt(0))`
const inlineScript = [bootstrap, appCode].join("\n").replace(/<\/script>/gi, "<\\/script>")

const replaced = html.replace(
  /<script type="module" src="\.\/app\.js"><\/script>/,
  `<style>\n${xtermCss}\n    </style>\n    <script type="module">\n${inlineScript}\n    </script>`,
)
if (replaced === html) throw new Error("could not find the app script tag in web/index.html")

const outfile = join(outdir, "opencode-standalone.html")
await writeFile(outfile, replaced, "utf8")

const kib = (n) => `${(n / 1024).toFixed(1)} KiB`
console.log(`dist/opencode-standalone.html  ${kib(replaced.length)}`)
console.log(`  wasm ${kib(wasm.length)} (base64 ${kib(wasmBase64.length)}) · app ${kib(appCode.length)} · css ${kib(xtermCss.length)}`)
console.log("  buka: start opencode-standalone.html  (server perlu --cors null)")
