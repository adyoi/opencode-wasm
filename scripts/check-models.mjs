// Check which free models the server can actually call right now.
// Usage: node scripts/check-models.mjs [baseUrl] [limit]
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { bootOpenCode } from "../web/bridge.js"

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4096"
const limit = Number(process.argv[3] ?? 8)
const waiting = new Map()

const wasm = await readFile(fileURLToPath(new URL("../web/pkg/opencode_wasm_bg.wasm", import.meta.url)))
const oc = await bootOpenCode({ wasm })
const call = (m, p = null) => new Promise((res, rej) => waiting.set(oc.call(m, p), { resolve: res, reject: rej }))
oc.on("reply", ({ ticket, ok, data, error }) => {
  const p = waiting.get(ticket)
  if (!p) return
  waiting.delete(ticket)
  ok ? p.resolve(data) : p.reject(new Error(error))
})

const textByModel = new Map()
oc.on("event", (evt) => {
  if (evt?.type === "session.next.text.ended") textByModel.set(evt.data?.assistantMessageID, evt.data?.text)
})

await call("open", { baseUrl })
const { data: models } = await call("models")
const free = models.filter((m) => (m.cost ?? []).every((c) => !c.input && !c.output))
console.log(`${free.length} free models, trying ${Math.min(limit, free.length)}\n`)

const done = new Set()
oc.on("event", (evt) => {
  const type = evt?.type ?? ""
  if (type === "session.step.failed" || type === "session.execution.failed") {
    const id = evt.data?.assistantMessageID
    if (id) done.add(id)
  }
})

let ok = 0
let failed = 0
for (const model of free.slice(0, limit)) {
  let session
  try {
    session = await call("createSession", { model: { id: model.id, providerID: model.providerID } })
  } catch (err) {
    console.log(`${model.id.padEnd(34)} session failed`)
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
process.exit(0)
