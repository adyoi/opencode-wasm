// Host-side glue between the page and the wasm module.
//
// The wasm binary carries the whole OpenCode JS runtime inside it, so this file
// only has to: instantiate the module, evaluate the embedded source, then keep
// pumping requests/replies/events across the wasm boundary.

import init, { OpenCode, runtimeSource, runtimeBytes, settle, event } from "./pkg/opencode_wasm.js"

const listeners = new Map()

function on(kind, fn) {
  if (!listeners.has(kind)) listeners.set(kind, new Set())
  listeners.get(kind).add(fn)
  return () => listeners.get(kind)?.delete(fn)
}

function emit(kind, value) {
  const handlers = listeners.get(kind)
  if (!handlers) return
  for (const handler of handlers) handler(value)
}

// requestAnimationFrame is throttled (or paused) in hidden tabs and missing in
// Node, so fall back to a timer whenever the page is not actively painting.
//
// The guard keeps exactly one chain alive. Both the loop itself and the
// visibilitychange listener call schedule(), and without it every tab switch
// would leave one more rAF chain running forever — each one pumping the wasm
// module and JSON-parsing its output on every frame.
let scheduled = false
const schedule = (cb) => {
  if (scheduled) return
  scheduled = true
  const run = () => {
    scheduled = false
    cb()
  }
  const visible = typeof document === "undefined" || document.visibilityState === "visible"
  if (visible && globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(run)
  else setTimeout(run, 16)
}

export async function bootOpenCode({ wasm } = {}) {
  // In the browser `wasm` is undefined (the glue fetches the file); the
  // standalone build assigns globalThis.__wasmBytes so nothing is fetched.
  const bytes = wasm ?? globalThis.__wasmBytes
  await init(bytes === undefined ? undefined : { module_or_path: bytes })

  const embeddedBytes = runtimeBytes()
  const source = runtimeSource()
  // Evaluate the runtime that is embedded in the wasm binary.
  ;(0, eval)(source)
  if (!globalThis.__oc) throw new Error("embedded runtime did not install globalThis.__oc")

  const client = new OpenCode()
  client.boot()

  let pumping = true

  function dispatch({ ticket, method, payload }) {
    const api = globalThis.__oc
    const fn = api?.[method]
    if (typeof fn !== "function") {
      return settle(ticket, false, JSON.stringify({ error: `unknown runtime method: ${method}` }))
    }

    // `subscribe` needs a live callback instead of a JSON payload.
    const argument = method === "subscribe" ? (raw) => event(raw) : payload

    try {
      Promise.resolve(fn(argument)).then(
        (value) => settle(ticket, true, JSON.stringify(value ?? null)),
        (err) => settle(ticket, false, JSON.stringify({ error: String(err?.stack || err) })),
      )
    } catch (err) {
      settle(ticket, false, JSON.stringify({ error: String(err?.stack || err) }))
    }
  }

  function pump() {
    if (!pumping) return
    // An idle frame is by far the common case. hasWork() is a cheap in-wasm
    // check, and skipping it avoids serialising an empty drain to JSON and
    // parsing it back on every single animation frame.
    if (client.hasWork()) {
      const drained = JSON.parse(client.pump())
      for (const request of drained.requests) dispatch(request)
      for (const reply of drained.replies) emit("reply", reply)
      for (const serverEvent of drained.events) emit("event", serverEvent)
    }
    schedule(pump)
  }

  schedule(pump)
  // Coming back to the tab should not wait for the next animation frame.
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => schedule(pump))

  return {
    embeddedBytes,
    /** Fire and forget: the result arrives as a `reply` event with the ticket. */
    call(method, payload = null) {
      return client.queue(method, JSON.stringify(payload))
    },
    remember: (id) => client.remember(id),
    session: () => client.session(),
    stats: () => JSON.parse(client.stats()),
    /**
     * Drop the connection to the server: aborts the in-flight fetches and the
     * event stream. The wasm module stays usable, so `open` can be called again.
     */
    close() {
      const api = globalThis.__oc
      return typeof api?.close === "function" ? api.close() : false
    },
    on,
    stop() {
      pumping = false
      client.reset()
    },
  }
}
