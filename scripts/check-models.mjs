// Check which free models the server can actually call right now.
// Usage: node scripts/check-models.mjs [baseUrl] [limit]
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { bootOpenCode } from "../web/bridge.js"

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4096"
const limit = Number(process.argv[3] ?? 8)
const waiting = new Map()
const CALL_TIMEOUT = 20_000

const wasm = await readFile(fileURLToPath(new URL("../web/pkg/opencode_wasm_bg.wasm", import.meta.url)))
const oc = await bootOpenCode({ wasm })
const call = (m, p = null) =>
  new Promise((resolve, reject) => {
    const ticket = oc.call(m, p)
    waiting.set(ticket, { resolve, reject })
    setTimeout(() => {
      if (!waiting.delete(ticket)) return
      reject(new Error(`${m} timed out after ${CALL_TIMEOUT}ms`))
    }, CALL_TIMEOUT)
  })
oc.on("reply", ({ ticket, ok, data, error }) => {
  const p = waiting.get(ticket)
  if (!p) return
  waiting.delete(ticket)
  ok ? p.resolve(data) : p.reject(new Error(error))
})

try {
  await call("open", { baseUrl })
} catch (err) {
  console.error(`cannot reach the opencode server at ${baseUrl}`)
  console.error(`  ${err.message}`)
  oc.stop()
  process.exit(1)
}

const { data: models } = await call("models")
// Same rule as the model picker in web/app.js: a model counts as free when
// nothing about it costs anything, including cache reads.
const free = models.filter((m) => (m.cost ?? []).every((c) => !c.input && !c.output && !c.cache?.read))
console.log(`${free.length} free models, trying ${Math.min(limit, free.length)}\n`)

let ok = 0
let failed = 0
for (const model of free.slice(0, limit)) {
  let session
  try {
    session = await call("createSession", { model: { id: model.id, providerID: model.providerID } })
  } catch (err) {
    console.log(`${model.id.padEnd(34)} session failed: ${String(err.message).slice(0, 90)}`)
    failed++
    continue
  }
  await call("subscribe", {}).catch(() => null)

  let answer = ""
  let error = null
  const off = oc.on("event", (evt) => {
    const type = evt?.type ?? ""
    if (type === "session.next.text.delta") answer += evt.data?.delta ?? ""
    if (type === "session.next.step.failed" || type === "session.next.execution.failed") {
      error = String(evt.data?.error?.message ?? evt.data?.error ?? "failed").slice(0, 90)
    }
  })

  try {
    await call("prompt", { sessionID: session.id, text: "Balas persis: ok" })
  } catch (err) {
    error = String(err.message).slice(0, 90)
  }

  const deadline = Date.now() + 45_000
  while (Date.now() < deadline && !answer && !error) {
    await new Promise((r) => setTimeout(r, 250))
  }
  off()

  if (answer) {
    ok++
    console.log(`${model.id.padEnd(34)} OK   "${answer.trim().slice(0, 40)}"`)
  } else {
    failed++
    console.log(`${model.id.padEnd(34)} FAIL ${error ?? "timeout"}`)
  }
}

console.log(`\n${ok} ok · ${failed} gagal`)
oc.stop()
// Non-zero when nothing worked: this used to exit 0 even with every model
// failing, so a wrapper script could not tell the two apart.
process.exit(ok > 0 ? 0 : 1)