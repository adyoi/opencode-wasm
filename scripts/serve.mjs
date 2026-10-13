// Minimal static server for the demo (correct MIME types for .wasm).
// Usage: node scripts/serve.mjs [root] [port]
import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { extname, join, normalize, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)))
const port = Number(process.argv[3] ?? process.env.PORT ?? 5173)

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
}).listen(port, "127.0.0.1", () => {
  console.log(`serving ${root}`)
  console.log(`opencode-wasm demo  ->  http://127.0.0.1:${port}/web/index.html`)
})
