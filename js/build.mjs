// Bundles the OpenCode JS runtime that gets embedded into the WebAssembly binary.
import { build } from "esbuild"
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { gzipSync } from "node:zlib"

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
  absWorkingDir: root,
  metafile: true,
  write: false,
  logLevel: "warning",
})

/**
 * esbuild bundles whatever it resolves but never hands back a package version,
 * so the version the bridge reports is looked up here. The manifest is found
 * through esbuild's own metafile rather than `import.meta.resolve` or
 * `require.resolve`: @opencode/client is ESM-only and its `exports` map exposes
 * neither a CJS condition nor a "./package.json" entry, so both resolvers throw
 * on it, and import.meta.resolve also moves between Node versions.
 */
function installedClientVersion() {
  const entry = Object.keys(result.metafile.inputs).find((path) => path.includes(`@opencode${"/"}client`))
  if (!entry) throw new Error("esbuild did not bundle @opencode/client")
  let dir = dirname(resolve(root, entry))
  for (;;) {
    const manifest = join(dir, "package.json")
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"))
      if (pkg.name === "@opencode/client") return pkg.version
    }
    const parent = dirname(dir)
    if (parent === dir) throw new Error("could not locate @opencode/client's package.json")
    dir = parent
  }
}
const clientVersion = installedClientVersion()

// Re-run with the version in place; the metafile walk above needs a first pass
// to locate the manifest, and the define must be known before minifying.
const bundled = await build({
  entryPoints: [join(root, "js", "entry.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  legalComments: "none",
  absWorkingDir: root,
  define: { __RUNTIME_VERSION__: JSON.stringify(clientVersion) },
  write: false,
  logLevel: "warning",
})

const outfile = join(outdir, "runtime.js")
writeFileSync(outfile, bundled.outputFiles[0].text, "utf8")

const bytes = readFileSync(outfile)
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`

// Sanity checks: the bundle must be evaluatable and must not leak Node builtins.
const source = bytes.toString("utf8")
const nodeBuiltin = source.match(/require\(["']node:[a-z_/]+["']\)/)
if (nodeBuiltin) throw new Error(`browser bundle still requires ${nodeBuiltin[0]}`)

// The injected version has to survive minification, otherwise the bridge would
// report "0.0.0" to the host and the mismatch would only show up at runtime.
if (!source.includes(clientVersion)) throw new Error(`bundle is missing @opencode/client@${clientVersion}`)
if (!source.includes("__ocReady")) throw new Error("bundle does not install the bridge")

// Measure the real thing. `size / 4` was a guess dressed up as a number.
const gzipped = gzipSync(bytes, { level: 9 }).length

console.log(`embedded runtime -> js/dist/runtime.js (${kb(bytes.length)}, gzip ${kb(gzipped)})`)
console.log(`  @opencode/client@${clientVersion}`)