// Confirm the PTY round trip: create a shell, type a command, read the output.
const base = process.argv[2] ?? "http://127.0.0.1:4096"

const created = await (await fetch(`${base}/api/pty`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    command: process.platform === "win32" ? "powershell.exe" : "bash",
    args: [],
    cwd: process.cwd(),
    title: "probe",
  }),
})).json()
const ptyID = created?.data?.id
console.log("pty ->", ptyID, created?.data?.status)

const ws = new WebSocket(`ws://127.0.0.1:4096/api/pty/${ptyID}/connect`)
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
  console.log("--- round trip:", plain.includes("hello-from-wasm") ? "OK" : "MISSING")

  const removed = await fetch(`${base}/api/pty/${ptyID}`, { method: "DELETE" }).catch(() => null)
  console.log("cleanup ->", removed?.status ?? "n/a")
  process.exit(0)
}, 6000)
