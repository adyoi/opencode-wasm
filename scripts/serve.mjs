import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { networkInterfaces } from "node:os"
import { extname, join, normalize, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Printable LAN addresses, so the console says where the demo can be opened.
 * Node dropped `info.name`, so the interface is looked up by its address.
 */
async function listAddresses() {
  const interfaces = await networkInterfaces()
  const out = []
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== "IPv4" || info.internal) continue
      out.push({ address: info.address, interface: name })
    }
  }
  return out
}

// Minimal static server for the demo (correct MIME types for .wasm).
// Usage: node scripts/serve.mjs [root] [port] [--host <address>]
//
// Binding to 0.0.0.0 lets other devices on the network open the demo over
// plain http, which is the only way they can reach a local opencode server:
// a browser blocks http:// requests to a private address from an https page,
// so Pages cannot serve as the entry point for a LAN address.
const args = process.argv.slice(2)
const hostIndex = args.indexOf("--host")
const host = hostIndex === -1 ? "127.0.0.1" : (args[hostIndex + 1] ?? "0.0.0.0")
const positional = args.filter((a, i) => !a.startsWith("--") && i !== hostIndex + 1)

const root = resolve(positional[0] ?? fileURLToPath(new URL("..", import.meta.url)))
const port = Number(positional[1] ?? process.env.PORT ?? 5173)

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost")
    let path = join(root, normalize(decodeURIComponent(url.pathname)))
    if (!path.startsWith(root)) throw new Error("outside root")
    if ((await stat(path).catch(() => null))?.isDirectory()) path = join(path, "index.html")
    const body = await readFile(path)
    res.writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      "cache-control": "no-store",
    })
    res.end(body)
  } catch {
    res.writeHead(404, { "content-type": "text/plain" })
    res.end("not found")
  }
}).listen(port, host, async () => {
  console.log(`serving ${root}`)
  console.log(`opencode-wasm demo  ->  http://127.0.0.1:${port}/web/index.html`)
  if (host === "0.0.0.0") {
    for (const { address, interface: name } of await listAddresses()) {
      console.log(`  juga tersedia di  ->  http://${address}:${port}/web/index.html   (${name})`)
    }
  }
})
