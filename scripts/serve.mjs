import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { networkInterfaces } from "node:os"
import { extname, join, normalize, relative, resolve, sep } from "node:path"
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
// Usage: node scripts/serve.mjs [root] [port] [--host <address>] [--all]
//
// Binding to 0.0.0.0 lets other devices on the network open the demo over
// plain http, which is the only way they can reach a local opencode server:
// a browser blocks http:// requests to a private address from an https page,
// so Pages cannot serve as the entry point for a LAN address.
//
// On anything other than loopback only the published part of the site is served
// - the root redirect, web/ and dist/. The repository root also holds
// tools/opencode-patched.exe (176 MB) and .gitignore, and neither belongs on the
// network. Pass --all to serve everything, as loopback mode does.
const args = process.argv.slice(2)
const hostIndex = args.indexOf("--host")
const host = hostIndex === -1 ? "127.0.0.1" : (args[hostIndex + 1] ?? "0.0.0.0")
const serveEverything = args.includes("--all") || host === "127.0.0.1" || host === "localhost"
// Drop the value that follows --host, but only when there is one. `hostIndex + 1`
// is 0 when --host is absent, and testing that index unconditionally threw the
// first positional argument away — so `serve.mjs <root> <port>` silently served
// <port> as the root and fell back to the default port.
const positional = args.filter((a, i) => !a.startsWith("--") && !(hostIndex !== -1 && i === hostIndex + 1))

const root = resolve(positional[0] ?? fileURLToPath(new URL("..", import.meta.url)))
const port = Number(positional[1] ?? process.env.PORT ?? 5173)

/** The only paths a visitor of the published site needs. */
const PUBLIC_PREFIXES = ["/web/", "/dist/"]
const PUBLIC_FILES = ["/index.html"]

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost")
    let path = join(root, normalize(decodeURIComponent(url.pathname)))
    // Compare against root *plus the separator*. A plain startsWith(root) also
    // accepts siblings whose name merely begins with it, so
    // /../opencode-wasm-secrets/x served fine from a LAN-bound server.
    if (path !== root && !path.startsWith(root + sep)) throw new Error("outside root")
    if ((await stat(path).catch(() => null))?.isDirectory()) path = join(path, "index.html")
    if (!serveEverything) {
      const rel = `/${relative(root, path).split(sep).join("/")}`
      if (!PUBLIC_FILES.includes(rel) && !PUBLIC_PREFIXES.some((prefix) => rel.startsWith(prefix))) {
        throw new Error("not published")
      }
    }
    const body = await readFile(path)
    res.writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    })
    res.end(body)
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" })
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
