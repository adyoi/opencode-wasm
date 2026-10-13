// Bundles the OpenCode JS runtime that gets embedded into the WebAssembly binary.
import { build } from "esbuild"
import { mkdirSync, statSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const outdir = join(root, "js", "dist")
mkdirSync(outdir, { recursive: true })

const result = await build({
  entryPoints: [join(root, "js", "entry.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  legalComments: "none",
  write: false,
  logLevel: "warning",
})

const outfile = join(outdir, "runtime.js")
const { writeFileSync } = await import("node:fs")
writeFileSync(outfile, result.outputFiles[0].text, "utf8")

const bytes = readFileSync(outfile)
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`

// Sanity checks: the bundle must be evaluatable and must not leak Node builtins.
const source = bytes.toString("utf8")
const nodeBuiltin = source.match(/require\(["']node:[a-z_/]+["']\)/)
if (nodeBuiltin) throw new Error(`browser bundle still requires ${nodeBuiltin[0]}`)

console.log(`embedded runtime -> js/dist/runtime.js (${kb(bytes.length)}, gzip ~${kb(statSync(outfile).size / 4)})`)
