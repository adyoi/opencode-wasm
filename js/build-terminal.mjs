// Bundle xterm.js for the shell panel (kept out of the wasm; the wasm only
// carries the opencode runtime).
import { build } from "esbuild"
import { statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

await build({
  stdin: {
    contents: `
      import "@xterm/xterm/css/xterm.css"
      export { Terminal } from "@xterm/xterm"
      export { FitAddon } from "@xterm/addon-fit"
    `,
    resolveDir: root,
    sourcefile: "xterm-entry.js",
    loader: "js",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  outdir: join(root, "web", "vendor"),
  entryNames: "xterm",
  logLevel: "warning",
})

for (const file of ["xterm.js", "xterm.css"]) {
  const path = join(root, "web", "vendor", file)
  try {
    console.log(`web/vendor/${file}  ${(statSync(path).size / 1024).toFixed(1)} KiB`)
  } catch {
    console.log(`web/vendor/${file}  (missing)`)
  }
}
