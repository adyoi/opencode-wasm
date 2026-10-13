import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { bootOpenCode } from "../web/bridge.js"

const baseUrl = "http://127.0.0.1:4096"
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

await call("open", { baseUrl })
try {
  const cfg = await call("config")
  console.log("config.model ->", cfg?.model)
} catch (e) {
  console.log("config FAIL ->", e.message.slice(0, 160))
}
try {
  const session = await call("createSession", { model: { id: "space-bunny-free", providerID: "opencode" } })
  console.log("session with model ->", session?.id)
} catch (e) {
  console.log("createSession(model) FAIL ->", e.message.slice(0, 300))
}
try {
  const session = await call("createSession", {})
  console.log("plain session ->", session?.id)
  await call("switchModel", { sessionID: session.id, model: { id: "space-bunny-free", providerID: "opencode" } })
  console.log("switchModel -> ok")
} catch (e) {
  console.log("switch FAIL ->", e.message.slice(0, 300))
}
oc.stop()
process.exit(0)
