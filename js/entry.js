// OpenCode runtime bridge.
//
// This file is bundled by esbuild into `js/dist/runtime.js` and then embedded
// into the WebAssembly binary by `include_str!` in rust/src/lib.rs. Nothing but
// the resulting `.wasm` file needs to be shipped to the browser.
//
// Every method returns either a plain value or a Promise. The host resolves the
// promise and reports the outcome back into the wasm module through
// `globalThis.__ocSettle(ticket, ok, payload)`, where `ticket` is the number
// returned by the call.

import { OpenCode } from "@opencode/client"

const RUNTIME_VERSION = "2.0.28"

let client = null
let baseUrl = null
let abort = null
let socket = null
let emitter = null

/** Push an event to whatever host sink `subscribe` installed. */
function emit(json) {
  emitter?.(json)
}

function require_() {
  if (!client) throw new Error("opencode client is not open, call __oc.open() first")
  return client
}

/**
 * Newer server builds wrap the prompt payload in `{ prompt: { text } }`, while the
 * published client (2.0.28) still sends the flattened `{ text }` shape and drops
 * unknown keys. Try the generated client first, then talk to the endpoint
 * directly when the server answers `Missing key ["prompt"]` — and remember the
 * shape so later prompts skip the doomed request.
 */
let promptStyle = null

async function sendPrompt(sessionID, text) {
  if (promptStyle !== "wrapped") {
    try {
      const result = await require_().session.prompt({ sessionID, text })
      promptStyle = "flat"
      return result
    } catch (err) {
      if (!/Missing key/i.test(String(err?.message ?? err))) throw err
      promptStyle = "wrapped"
    }
  }

  const res = await fetch(`${baseUrl}/api/session/${encodeURIComponent(sessionID)}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: { text } }),
  })
  const payload = await res.json().catch(() => null)
  if (!res.ok) throw new Error(payload?.message ?? `prompt failed with ${res.status}`)
  return payload?.data ?? payload
}

export const bridge = {
  version: RUNTIME_VERSION,

  /** Instantiate the official OpenCode client against a running server. */
  open(options) {
    abort?.abort()
    abort = new AbortController()
    baseUrl = options.baseUrl?.replace(/\/$/, "") ?? null
    client = OpenCode.make({
      baseUrl: options.baseUrl,
      headers: options.headers,
    })
    return { runtime: RUNTIME_VERSION, baseUrl }
  },

  close() {
    abort?.abort()
    abort = null
    client = null
    baseUrl = null
    return true
  },

  /** Server metadata: version, uptime, project, ... */
  info() {
    return require_().server.info()
  },

  /** Agents available on the server (build, plan, general, ...). */
  agents() {
    return require_().agent.list()
  },

  /** Models known to the server. */
  models() {
    return require_().model.list()
  },

  /** Effective server config (used to preselect the default model). */
  async config() {
    try {
      const out = await require_().config.get()
      return out?.data ?? out
    } catch {
      const res = await fetch(`${baseUrl}/config`)
      if (!res.ok) throw new Error(`config failed with ${res.status}`)
      return res.json()
    }
  },

  /** Create a session. `input` is a SessionCreateInput object. */
  createSession(input) {
    return require_().session.create(input ?? {})
  },

  /** Send a prompt into a session. `input` is `{ sessionID, text }`. */
  prompt(input) {
    return sendPrompt(input.sessionID, input.text ?? input.prompt?.text ?? "")
  },

  /** Full message history of a session: `message.list({ sessionID })`. */
  messages(input) {
    return require_().message.list(input)
  },

  /** Ask the server to interrupt the running turn. */
  interrupt(input) {
    return require_().session.interrupt(input)
  },

  /** Switch the model of an existing session. `model` is `{ id, providerID }`. */
  switchModel(input) {
    return require_().session.switchModel({ sessionID: input.sessionID, model: input.model })
  },

  /**
   * Answer a permission request raised by the agent.
   * `decision` is "once" | "always" | "reject" — "always" persists the grant.
   *
   * v2 servers emit `permission.v2.asked` and expect
   * `POST /api/session/:id/permission/:requestID/reply` with `{ reply }`, while
   * the generated client still speaks the v1 route, so try v2 first.
   */
  async replyPermission(input) {
    const decision = input.decision ?? "once"
    const body = input.message ? { reply: decision, message: input.message } : { reply: decision }
    const url = `${baseUrl}/api/session/${encodeURIComponent(input.sessionID)}/permission/${encodeURIComponent(input.requestID)}/reply`

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (response.ok) return { ok: true, api: "v2", decision }
    if (response.status !== 404) {
      const detail = await response.text().catch(() => "")
      throw new Error(detail.slice(0, 200) || `permission reply failed with ${response.status}`)
    }

    // Older servers only expose the v1 route.
    await require_().permission.reply({ sessionID: input.sessionID, requestID: input.requestID, decision })
    return { ok: true, api: "v1", decision }
  },

  /**
   * Consume the server event stream. `sink` is the host callback and is called
   * with one JSON string per event; PTY output uses the same sink.
   */
  subscribe(sink) {
    emitter = sink
    abort?.abort()
    abort = new AbortController()
    const signal = abort.signal
    ;(async () => {
      try {
        for await (const event of require_().event.subscribe({ signal })) {
          if (signal.aborted) break
          sink(JSON.stringify(event))
        }
      } catch (err) {
        if (!signal.aborted) sink(JSON.stringify({ type: "stream.error", properties: { error: String(err) } }))
      }
    })()
    return true
  },

  unsubscribe() {
    emitter = null
    abort?.abort()
    abort = null
    return true
  },

  /* ---------------- shell (PTY on the opencode server) ---------------- */

  /**
   * Start a shell on the server. `input` is
   * `{ command, args, cwd, title, env }`; omitting `command` uses the server
   * default shell.
   */
  async ptyCreate(input) {
    const response = await fetch(`${baseUrl}/api/pty`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: input?.command,
        args: input?.args ?? [],
        cwd: input?.cwd,
        title: input?.title ?? "shell",
        env: input?.env,
      }),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new Error(payload?.message ?? `pty create failed with ${response.status}`)
    const pty = payload?.data ?? payload
    return { ptyID: pty?.id, status: pty?.status, command: pty?.command, cwd: pty?.cwd }
  },

  /**
   * Attach to the PTY websocket. Output frames are pushed to `emit` as
   * `{ type: "pty.output", data: { ptyID, chunk, control } }`.
   */
  ptyConnect(input) {
    const { ptyID } = input ?? {}
    if (!ptyID) throw new Error("ptyID is required")
    socket?.close()

    const url = `${baseUrl.replace(/^http/, "ws")}/api/pty/${encodeURIComponent(ptyID)}/connect`
    socket = new WebSocket(url)
    socket.binaryType = "arraybuffer"

    socket.addEventListener("message", async (event) => {
      const chunk =
        typeof event.data === "string"
          ? event.data
          : event.data instanceof ArrayBuffer
            ? new TextDecoder().decode(event.data)
            : await event.data.text()
      // The server prefixes control frames with NUL (e.g. cursor position).
      const control = chunk.charCodeAt(0) === 0
      emit(JSON.stringify({ type: "pty.output", data: { ptyID, chunk: control ? chunk.slice(1) : chunk, control } }))
    })

    socket.addEventListener("close", () => emit(JSON.stringify({ type: "pty.closed", data: { ptyID } })))
    socket.addEventListener("error", () => emit(JSON.stringify({ type: "pty.closed", data: { ptyID, error: "socket error" } })))

    return new Promise((resolve) => {
      socket.addEventListener("open", () => resolve({ ok: true, ptyID }), { once: true })
      socket.addEventListener("error", () => resolve({ ok: false, ptyID }), { once: true })
    })
  },

  /** Send keystrokes to the attached PTY. */
  ptyInput(input) {
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("pty socket is not open")
    socket.send(input?.data ?? "")
    return { ok: true, bytes: (input?.data ?? "").length }
  },

  /** Detach from the websocket and delete the PTY on the server. */
  async ptyClose(input) {
    const { ptyID } = input ?? {}
    socket?.close()
    socket = null
    if (ptyID) {
      await fetch(`${baseUrl}/api/pty/${encodeURIComponent(ptyID)}`, { method: "DELETE" }).catch(() => null)
    }
    return { ok: true }
  },
}

globalThis.__oc = bridge
globalThis.__ocReady = true
