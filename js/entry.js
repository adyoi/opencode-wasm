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

// Injected by js/build.mjs from the installed @opencode/client package.json, so
// the version reported to the host cannot drift away from the client that is
// actually embedded. The fallback only matters when this file is loaded raw.
const RUNTIME_VERSION = typeof __RUNTIME_VERSION__ === "string" ? __RUNTIME_VERSION__ : "0.0.0"

let client = null
let baseUrl = null
let abort = null
let socket = null
let socketPtyID = null
let emitter = null
let extraHeaders = {}

/** Push an event to whatever host sink `subscribe` installed. */
function emit(json) {
  emitter?.(json)
}

function require_() {
  if (!client) throw new Error("opencode client is not open, call __oc.open() first")
  return client
}

/** The normalised base URL. Every direct fetch builds its URL from this. */
function requireBaseUrl() {
  if (!baseUrl) throw new Error("opencode client has no baseUrl, call __oc.open(url) first")
  return baseUrl
}

/**
 * Drop the current PTY socket without telling anyone. Used before reconnecting:
 * the previous socket's close handler is a no-op once it is no longer the
 * current one, so a stale shell can never report itself as the closed one.
 */
function detachSocket() {
  const previous = socket
  socket = null
  socketPtyID = null
  previous?.close()
}

/**
 * Newer server builds wrap the prompt payload in `{ prompt: { text } }`, while the
 * published client (2.0.28) still sends the flattened `{ text }` shape and drops
 * unknown keys. Try the generated client first, then talk to the endpoint
 * directly — and remember the shape so later prompts skip the doomed request.
 *
 * The mismatch is not reported one way. Depending on the server build the flat
 * shape comes back as a zod `Missing key ["prompt"]` or as a bare HTTP 400, and
 * matching only the first left prompts failing with nothing the user could act
 * on. Any 4xx is worth one retry with the wrapped shape; the retry is free
 * because the flat request was rejected before it did any work.
 */
let promptStyle = readPromptStyle()

const SHAPE_MISMATCH = /Missing key|UnexpectedStatus:\s*4\d\d|UnexpectedStatus:4\d\d|status(?: code)?:?\s*4\d\d/i

/**
 * The learned shape is kept in sessionStorage so a reload does not pay the
 * rejected first attempt again — it shows up as a 400 in the network panel
 * every time the page starts fresh.
 */
const PROMPT_STYLE_KEY = "opencode-prompt-style"

function readPromptStyle() {
  try {
    return globalThis.sessionStorage?.getItem(PROMPT_STYLE_KEY) === "flat" ? "flat" : null
  } catch {
    return null
  }
}

function rememberPromptStyle(style) {
  promptStyle = style
  try {
    if (style === "flat") globalThis.sessionStorage?.setItem(PROMPT_STYLE_KEY, "flat")
    else globalThis.sessionStorage?.removeItem(PROMPT_STYLE_KEY)
  } catch {
    /* no storage: the in-memory value still holds for this page */
  }
}

async function sendPrompt(sessionID, text) {
  if (promptStyle !== "wrapped") {
    try {
      const result = await require_().session.prompt({ sessionID, text })
      rememberPromptStyle("flat")
      return result
    } catch (err) {
      if (!SHAPE_MISMATCH.test(String(err?.message ?? err))) throw err
      rememberPromptStyle("wrapped")
    }
  }

  const res = await fetch(`${requireBaseUrl()}/api/session/${encodeURIComponent(sessionID)}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
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
    // Normalise once and hand the same value to the generated client: a
    // trailing slash would otherwise produce `//api/...` in every route.
    baseUrl = options.baseUrl?.trim().replace(/\/+$/, "") || null
    extraHeaders = options.headers ?? {}
    client = OpenCode.make({
      baseUrl,
      headers: extraHeaders,
    })
    return { runtime: RUNTIME_VERSION, baseUrl, auth: Boolean(extraHeaders.Authorization) }
  },

  close() {
    abort?.abort()
    abort = null
    detachSocket()
    client = null
    baseUrl = null
    extraHeaders = {}
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
      const res = await fetch(`${requireBaseUrl()}/config`, { headers: { ...extraHeaders } })
      if (!res.ok) throw new Error(`config failed with ${res.status}`)
      return res.json()
    }
  },

  /**
   * Effective provider config: the only place model `variants` are declared.
   * `/api/model` returns an empty array for them on every model.
   */
  async configProviders() {
    const res = await fetch(`${requireBaseUrl()}/config/providers`, { headers: { ...extraHeaders } })
    if (!res.ok) throw new Error(`config/providers failed with ${res.status}`)
    const payload = await res.json().catch(() => null)
    return payload?.data ?? payload
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
   * Switch the agent of an existing session — build, plan, general, explore.
   * The generated client has no method for this route, and the API takes a bare
   * `{ agent }` body, so it goes out as a direct fetch.
   */
  async setAgent(input) {
    const response = await fetch(
      `${requireBaseUrl()}/api/session/${encodeURIComponent(input.sessionID)}/agent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...extraHeaders },
        body: JSON.stringify({ agent: input.agent }),
      },
    )
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new Error(payload?.message ?? `agent switch failed with ${response.status}`)
    return { agent: input.agent, ...(payload?.data ?? {}) }
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
    const url = `${requireBaseUrl()}/api/session/${encodeURIComponent(input.sessionID)}/permission/${encodeURIComponent(input.requestID)}/reply`

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
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
    const response = await fetch(`${requireBaseUrl()}/api/pty`, {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
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
    // Browsers cannot attach headers to a WebSocket handshake, so a server that
    // requires basic auth will reject the shell stream even when the API calls
    // work. Say so instead of failing with a bare "socket closed".
    if (extraHeaders.Authorization) {
      throw new Error("AUTH_WS_UNSUPPORTED")
    }
    detachSocket()

    const url = `${requireBaseUrl().replace(/^http/, "ws")}/api/pty/${encodeURIComponent(ptyID)}/connect`
    const ws = new WebSocket(url)
    ws.binaryType = "arraybuffer"
    socket = ws
    socketPtyID = ptyID

    ws.addEventListener("message", async (event) => {
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

    // `error` is always followed by `close`, so the flag keeps the host from
    // seeing two `pty.closed` events for one socket.
    let closed = false
    const finish = (error) => {
      if (closed) return
      closed = true
      if (socket === ws) {
        socket = null
        socketPtyID = null
      }
      emit(JSON.stringify({ type: "pty.closed", data: error ? { ptyID, error } : { ptyID } }))
    }
    ws.addEventListener("close", () => finish())
    ws.addEventListener("error", () => finish("socket error"))

    return new Promise((resolve) => {
      ws.addEventListener("open", () => resolve({ ok: true, ptyID }), { once: true })
      ws.addEventListener("error", () => resolve({ ok: false, ptyID }), { once: true })
    })
  },

  /** Send keystrokes to the attached PTY. */
  ptyInput(input) {
    const data = input?.data ?? ""
    // Keystrokes only make sense for the shell that is actually attached; a late
    // event from the previous one would otherwise be typed into the new shell.
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("pty socket is not open")
    if (input?.ptyID && input.ptyID !== socketPtyID) return { ok: false, reason: "stale pty", bytes: 0 }
    socket.send(data)
    return { ok: true, bytes: data.length }
  },

  /** Detach from the websocket and delete the PTY on the server. */
  async ptyClose(input) {
    const { ptyID } = input ?? {}
    detachSocket()
    if (ptyID) {
      await fetch(`${requireBaseUrl()}/api/pty/${encodeURIComponent(ptyID)}`, {
        method: "DELETE",
        headers: { ...extraHeaders },
      }).catch(() => null)
    }
    return { ok: true }
  },
}

globalThis.__oc = bridge
globalThis.__ocReady = true
