// Headless smoke test: drives the wasm module the same way web/bridge.js does,
// but from Node. Usage: node scripts/smoke.mjs [baseUrl] [--prompt "text"]
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { bootOpenCode } from "../web/bridge.js"

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4096"
const waiting = new Map()
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`

// Without this, a server that accepts the socket and then goes quiet leaves the
// process waiting forever instead of failing.
const CALL_TIMEOUT = 20_000

const wasm = await readFile(fileURLToPath(new URL("../web/pkg/opencode_wasm_bg.wasm", import.meta.url)))
const oc = await bootOpenCode({ wasm })
console.log(`wasm ready · embedded runtime ${kb(oc.embeddedBytes)} · wasm ${kb(wasm.length)}`)

const call = (method, payload = null) =>
  new Promise((resolve, reject) => {
    const ticket = oc.call(method, payload)
    waiting.set(ticket, { resolve, reject })
    setTimeout(() => {
      if (!waiting.delete(ticket)) return
      reject(new Error(`${method} timed out after ${CALL_TIMEOUT}ms`))
    }, CALL_TIMEOUT)
  })

const text = process.argv.includes("--prompt")
  ? (process.argv[process.argv.indexOf("--prompt") + 1] ?? "reply with exactly: wasm ok")
  : null

let answer = ""
let done = false
oc.on("event", (evt) => {
  // v2 servers emit `session.next.*`; normalise so both generations work.
  const type = (evt?.type ?? "unknown").replace(/^session\.next\./, "session.")
  const data = evt?.data ?? {}
  if (type === "session.text.delta") {
    answer += data.delta ?? ""
    return
  }
  if (type === "session.text.ended") {
    answer = data.text ?? answer
    return
  }
  if (type.startsWith("session.tool.")) {
    console.log(`  tool ${data.tool ?? ""} ${JSON.stringify(data.input ?? {}).slice(0, 80)}`)
    return
  }
  if (["session.step.ended", "session.idle", "session.execution.succeeded", "session.execution.failed"].includes(type)) {
    console.log(`  event ${type} ${JSON.stringify(data.finish ?? data.error ?? "")}`)
    if (type !== "session.idle") done = true
  }
})

oc.on("reply", ({ ticket, ok, data, error }) => {
  const pending = waiting.get(ticket)
  if (!pending) return
  waiting.delete(ticket)
  ok ? pending.resolve(data) : pending.reject(new Error(error))
})

console.log(`open ${baseUrl}`)
// `open` only wires up the client, so it succeeds even when nothing is
// listening. The first real request is what proves the server is there, and
// every later step is wrapped: an unguarded rejection from any of them used to
// escape as a raw stack trace and a non-zero exit.
async function step(label, fn) {
  try {
    return await fn()
  } catch (err) {
    // The embedded client reports failures as a JSON blob with a stack in it.
    // First line, capped, is the part a human can act on.
    const reason = String(err?.message ?? err).replace(/\s*at [\s\S]*$/, "").slice(0, 160)
    console.error(`${label} failed: ${reason}`)
    oc.stop()
    process.exit(1)
  }
}

let failure = null
await step("open", () => call("open", { baseUrl }))

const label = await step("info", async () => {
  try {
    const info = await call("info")
    return info?.version ?? info?.data?.version ?? "unknown"
  } catch {
    return "(no /info route)"
  }
})
console.log("server ->", label)

const agents = await step("agents", () => call("agents"))
console.log("agents ->", (agents?.data ?? []).map((a) => a.id).join(", ") || "(none configured)")

const models = await step("models", () => call("models"))
const free = [...new Set((models?.data ?? []).map((m) => m.id).filter((id) => id.endsWith("-free") || id === "big-pickle"))]
console.log("free models ->", `${free.length} available`, free.slice(0, 5).join(", "))

const session = await step("createSession", () => call("createSession", {}))
const sessionID = session?.id ?? session?.sessionID
oc.remember(sessionID ?? "")
console.log("session ->", sessionID)

await step("subscribe", () => call("subscribe", {}))

if (text) {
  console.log(`prompt -> ${JSON.stringify(text)}`)
  await step("prompt", () => call("prompt", { sessionID, text }))
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline && !done) {
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!done) {
    console.log("(timed out waiting for the turn to finish)")
    failure = "the turn never finished"
  } else if (!answer.trim()) {
    console.log("(no text streamed)")
    failure = "the turn finished without any text"
  }
  console.log("answer ->", answer.trim() || "(no text streamed)")
}

console.log("stats ->", JSON.stringify(oc.stats()))
oc.stop()
// Exit non-zero on a failed turn so this can gate a script. It used to exit 0
// unconditionally, which made every failure look like a pass.
process.exit(failure ? 1 : 0)
