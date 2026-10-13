// Verify a freshly built wasm module without needing a running server.
//
// The committed artifacts cannot be compared byte-for-byte: wasm-pack output
// embeds toolchain-specific data, so the same source produces a different file
// on every machine. What actually matters is that the module boots and carries a
// working opencode runtime, so that is what gets checked.
//
// Usage: node scripts/verify-build.mjs [path/to/opencode_wasm_bg.wasm]
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const wasmPath = process.argv[2] ?? fileURLToPath(new URL("../web/pkg/opencode_wasm_bg.wasm", import.meta.url))
const bytes = await readFile(wasmPath)

// 1. the module must be a real WebAssembly binary
if (bytes.subarray(0, 4).toString("hex") !== "0061736d") throw new Error("not a wasm module")
if (bytes.length < 40_000) throw new Error(`wasm suspiciously small: ${bytes.length} bytes`)

// 2. it must embed the opencode runtime, not just an empty shell
const text = bytes.toString("latin1")
for (const marker of [
  "__ocReady", // bridge installed
  "createSession",
  "switchModel",
  "replyPermission",
  "ptyCreate",
  "ptyConnect",
  "/api/pty", // PTY endpoints
  "Missing key", // prompt schema fallback
]) {
  if (!text.includes(marker)) throw new Error(`embedded runtime is missing "${marker}"`)
}
if (!/Authorization/i.test(text)) throw new Error("embedded runtime has no basic-auth support")

// 3. and it must actually instantiate and expose the bridge
const { default: init, OpenCode, runtimeSource, runtimeBytes } = await import("../web/pkg/opencode_wasm.js")
await init({ module_or_path: bytes })

const source = runtimeSource()
if (source.length !== runtimeBytes()) throw new Error("runtimeSource length does not match runtimeBytes")
;(0, eval)(source)
if (typeof globalThis.__oc?.open !== "function") throw new Error("runtime did not install the bridge")
if (typeof globalThis.__oc?.ptyConnect !== "function") throw new Error("bridge is missing ptyConnect")

const client = new OpenCode()
client.boot()
const ticket = client.queue("info", "null")
const drained = JSON.parse(client.pump())
if (drained.requests?.[0]?.ticket !== ticket) throw new Error("queue/pump round trip failed")

const kib = (n) => `${(n / 1024).toFixed(1)} KiB`
console.log(`wasm ok · ${kib(bytes.length)} · embedded runtime ${kib(runtimeBytes())} · queue ticket ${ticket}`)
