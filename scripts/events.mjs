// Print the event types a turn produces, so the UI handlers can be aligned.
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { bootOpenCode } from "../web/bridge.js"

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4096"
const text = process.argv[3] ?? "say hi in three words"
const waiting = new Map()
const counts = new Map()

const wasm = await readFile(fileURLToPath(new URL("../web/pkg/opencode_wasm_bg.wasm", import.meta.url)))
const oc = await bootOpenCode({ wasm })
const call = (method, payload = null) =>
  new Promise((resolve, reject) => waiting.set(oc.call(method, payload), { resolve, reject }))

oc.on("reply", ({ ticket, ok, data, error }) => {
  const p = waiting.get(ticket)
  if (!p) return
  waiting.delete(ticket)
  ok ? p.resolve(data) : p.reject(new Error(error))
})

oc.on("event", (evt) => {
  const type = evt?.type ?? "unknown"
  counts.set(type, (counts.get(type) ?? 0) + 1)
  if ((counts.get(type) ?? 0) <= 2) {
    console.log(`[${type}]`, JSON.stringify(evt?.data ?? {}).slice(0, 220))
  }
})

await call("open", { baseUrl })
const session = await call("createSession", {})
await call("subscribe", {})
await call("prompt", { sessionID: session.id, text })
await new Promise((r) => setTimeout(r, 45_000))

console.log("\n--- counts ---")
for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${n}x ${type}`)
oc.stop()
process.exit(0)
