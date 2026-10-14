// Confirm the PTY round trip: create a shell, type a command, read the output.
// Usage: node scripts/probe-pty.mjs [baseUrl]
const base = (process.argv[2] ?? "http://127.0.0.1:4096").replace(/\/+$/, "")
// Derive the websocket URL from the server that was actually probed. It used to
// be hardcoded to ws://127.0.0.1:4096, so any other baseUrl — including an
// https:// one, which needs wss:// — silently attached to the wrong place.
const wsUrl = base.replace(/^http/, "ws")

const createdResponse = await fetch(`${base}/api/pty`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    command: process.platform === "win32" ? "powershell.exe" : "bash",
    args: [],
    cwd: process.cwd(),
    title: "probe",
  }),
})
if (!createdResponse.ok) {
  console.error(`pty create failed: ${createdResponse.status} ${createdResponse.statusText}`)
  process.exit(1)
}
const created = await createdResponse.json()
const ptyID = created?.data?.id
console.log("pty ->", ptyID, created?.data?.status)
if (!ptyID) {
  console.error("server returned no pty id")
  process.exit(1)
}

const ws = new WebSocket(`${wsUrl}/api/pty/${ptyID}/connect`)
ws.binaryType = "arraybuffer"
let output = ""
let sent = false

const decode = async (data) =>
  typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : await data.text()

ws.addEventListener("open", () => console.log("ws open"))
ws.addEventListener("message", async (event) => {
  const text = await decode(event.data)
  output += text
  const ready = process.platform === "win32" ? output.includes("PS ") : output.includes("$ ")
  if (!sent && ready) {
    sent = true
    setTimeout(() => ws.send("echo hello-from-wasm\r"), 300)
  }
})
ws.addEventListener("close", () => console.log("ws closed"))

setTimeout(async () => {
  ws.close()
  const plain = output.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "")
  console.log("--- stripped output ---")
  console.log(plain.slice(-600))
  const roundTrip = plain.includes("hello-from-wasm")
  console.log("--- round trip:", roundTrip ? "OK" : "MISSING")

  const removed = await fetch(`${base}/api/pty/${ptyID}`, { method: "DELETE" }).catch(() => null)
  console.log("cleanup ->", removed?.status ?? "n/a")
  // A probe that never saw its own echo is a failed probe: say so in the exit
  // code so it can gate a script instead of always reporting success.
  process.exit(roundTrip ? 0 : 1)
}, 6000)
