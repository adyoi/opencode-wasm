      import { bootOpenCode } from "./bridge.js"

      const $ = (id) => document.getElementById(id)
      const thread = $("thread")
      const main = $("main")

      const bubbles = new Map()
      const toolState = new Map()
      const waiting = new Map()
      const models = new Map()

      let oc = null
      let sessionID = null
      let connected = false
      let streaming = null
      let stepShown = false
      let autoAllow = localStorage.getItem("opencode-auto-allow") !== "false"

      const kb = (n) => `${(n / 1024).toFixed(1)} KiB`
      const scroll = () => main.scrollTo({ top: main.scrollHeight })

      /* ---------- rendering ---------- */

      function add(role, text, meta) {
        const node = document.createElement("div")
        node.className = `msg ${role}`
        node.innerHTML =
          (meta ? `<div class="meta"></div>` : "") + `<div class="body"></div>`
        if (meta) node.querySelector(".meta").textContent = meta
        const body = node.querySelector(".body")
        body.textContent = text ?? ""
        thread.appendChild(node)
        scroll()
        return { node, body, text: body.textContent }
      }

      function caret(on) {
        const previous = streaming?.node.querySelector(".caret")
        previous?.remove()
        if (!on || !streaming) return
        const mark = document.createElement("span")
        mark.className = "caret"
        streaming.node.appendChild(mark)
      }

      function toolLine(data) {
        const name = data.tool || data.name || "tool"
        const input = data.input ?? {}
        const isWeb = name === "webfetch" || name === "websearch"
        const detail =
          typeof input === "string"
            ? input
            : name === "webfetch"
              ? (input.url ?? "")
              : name === "websearch"
                ? (input.query ?? "")
                : input
                  ? JSON.stringify(input)
                  : ""

        const node = document.createElement("div")
        node.className = `tool${isWeb ? " web" : ""}`
        node.innerHTML = `<span class="name"></span><span class="args"></span><span class="state">…</span>`
        node.querySelector(".name").textContent = isWeb ? (name === "webfetch" ? "↗" : "⌕") + " " + name : name
        node.querySelector(".args").textContent =
          typeof detail === "string" ? detail : JSON.stringify(detail ?? "")
        thread.appendChild(node)
        scroll()

        // Web tools get a shortcut into the browser panel.
        if (isWeb) {
          const target =
            name === "webfetch"
              ? input.url
              : `https://duckduckgo.com/html/?q=${encodeURIComponent(input.query ?? "")}`
          if (target) {
            const open = document.createElement("button")
            open.textContent = "buka"
            open.title = "buka di panel Web"
            open.onclick = () => showTab("web").then(() => openInPanel(target))
            node.querySelector(".args").after(open)
          }
        }

        return node.querySelector(".state")
      }

      const clip = (v, n = 180) => {
        const text = typeof v === "string" ? v : JSON.stringify(v ?? "")
        return text.length > n ? `${text.slice(0, n)}…` : text
      }

      function system(text) {
        add("system", text)
      }

      /* ---------- permissions ---------- */

      function onPermission(data) {
        const requestID = data.id
        if (!requestID || !sessionID) return
        if (autoAllow) {
          replyPermission(requestID, "always")
          system(`izin ${data.action ?? "?"} → selalu`)
          return
        }
        permissionCard(data, requestID)
      }

      async function replyPermission(requestID, decision) {
        if (!sessionID) return
        try {
          await call("replyPermission", { sessionID, requestID, decision })
        } catch (err) {
          add("error", `izin gagal: ${err?.message ?? err}`)
        }
      }

      function permissionCard(data, requestID) {
        const node = document.createElement("div")
        node.className = "msg perm"
        node.innerHTML = `<div class="meta"></div><div class="body"></div><div class="actions"></div>`
        node.querySelector(".meta").textContent = `izin · ${data.action ?? "?"}`
        node.querySelector(".body").textContent =
          data.message || (data.resources ?? []).join(", ") || "tanpa detail"
        thread.appendChild(node)
        scroll()

        const actions = node.querySelector(".actions")
        const finish = (decision, label) => {
          node.querySelector(".body").textContent = `${data.action ?? "?"} → ${label}`
          actions.innerHTML = ""
          replyPermission(requestID, decision)
        }
        for (const [decision, label, cls] of [
          ["always", "selalu izinkan", "allow"],
          ["once", "sekali", ""],
          ["reject", "tolak", ""],
        ]) {
          const button = document.createElement("button")
          button.textContent = label
          if (cls) button.className = cls
          button.onclick = () => finish(decision, label)
          actions.appendChild(button)
        }
      }

      /* ---------- server events ---------- */

      function onEvent(evt) {
        // v2 servers emit `session.next.*` and `permission.v2.*`, and carry the
        // payload under `properties`; normalise both so one handler set fits.
        const type = (evt?.type ?? "unknown")
          .replace(/^session\.next\./, "session.")
          .replace(/^permission\.v\d+\./, "permission.")
        const data = evt?.data ?? evt?.properties ?? {}
        if (data.sessionID && sessionID && data.sessionID !== sessionID) return

        switch (type) {
          case "session.step.started":
            setBusy(true)
            // One line per turn, not per step.
            if (!stepShown) {
              stepShown = true
              system(`▸ ${data.agent ?? "agent"} · ${data.model?.id ?? "model"}`)
            }
            break

          case "session.text.started": {
            const id = data.assistantMessageID || data.messageID || "last"
            const meta = ["assistant", data.agent].filter(Boolean).join(" · ")
            streaming = bubbles.get(id) ?? add("assistant", "", meta)
            bubbles.set(id, streaming)
            caret(true)
            break
          }

          case "session.text.delta": {
            const id = data.assistantMessageID || data.messageID || "last"
            const entry = bubbles.get(id) ?? (streaming ?? add("assistant", ""))
            bubbles.set(id, entry)
            entry.text += data.delta ?? ""
            entry.body.textContent = entry.text
            scroll()
            break
          }

          case "session.text.ended": {
            const id = data.assistantMessageID || data.messageID || "last"
            const entry = bubbles.get(id) ?? streaming ?? add("assistant", "")
            entry.text = data.text ?? entry.text
            entry.body.textContent = entry.text
            caret(false)
            streaming = null
            break
          }

          case "session.tool.called":
            toolState.set(data.callID || data.tool, toolLine(data))
            break

          case "session.tool.success":
          case "session.tool.failed": {
            const state = toolState.get(data.callID)
            if (state) state.textContent = type.endsWith("failed") ? "✗" : "✓"
            break
          }

          case "session.step.ended":
          case "session.idle":
            caret(false)
            streaming = null
            setBusy(false)
            break

          case "session.step.failed":
          case "session.execution.failed":
            caret(false)
            setBusy(false)
            add("error", `gagal: ${clip(data.error ?? data.message ?? data)}`)
            break

          case "session.model.selected":
            system(`model → ${data.model?.id ?? "?"}`)
            break

          case "permission.asked":
            onPermission(data)
            break

          case "pty.output":
            if (!data.control && term) term.write(data.chunk)
            break

          case "pty.closed":
            if (data.ptyID === ptyID) {
              shellStatus("selesai", data.error ? "err" : "")
              if (term) term.writeln(`\r\n\x1b[90m[shell ditutup${data.error ? `: ${data.error}` : ""}]\x1b[0m`)
            }
            break

          default:
            $("counterMeta").textContent = $("counterMeta").textContent.replace(/ · last:.*$/, "") + ` · last: ${type}`
        }
      }

      /* ---------- web panel ---------- */

      const history = []
      let historyIndex = -1

      const normaliseUrl = (raw) => {
        const text = (raw ?? "").trim()
        if (!text) return "about:blank"
        if (/^https?:\/\//i.test(text)) return text
        return `https://${text}`
      }

      function openInPanel(url, { push = true } = {}) {
        const target = normaliseUrl(url)
        if (push) {
          history.splice(historyIndex + 1)
          history.push(target)
          historyIndex = history.length - 1
        }
        $("webUrl").value = target
        $("webEmpty").hidden = true
        $("webview").src = target
      }

      function step(delta) {
        const next = historyIndex + delta
        if (next < 0 || next >= history.length) return
        historyIndex = next
        openInPanel(history[next], { push: false })
      }

      /* ---------- tabs ---------- */

      async function showTab(name) {
        document.body.classList.toggle("shell", name === "shell")
        document.body.classList.toggle("web", name === "web")
        $("tabChat").setAttribute("aria-selected", String(name === "chat"))
        $("tabShell").setAttribute("aria-selected", String(name === "shell"))
        $("tabWeb").setAttribute("aria-selected", String(name === "web"))

        if (name === "shell") {
          await ensureTerminal()
          try {
            fitAddon?.fit()
          } catch {}
          if (!ptyID) await startShell()
          else term?.focus()
        }
      }

      /* ---------- shell (PTY di server, stream lewat wasm) ---------- */

      let term = null
      let fitAddon = null
      let ptyID = null

      function shellStatus(label, kind) {
        $("shellStatusText").textContent = label
        $("shellStatus").className = `status ${kind ?? ""}`
      }

      async function ensureTerminal() {
        if (term) return term
        const { Terminal, FitAddon } = await import("./vendor/xterm.js")
        // The standalone build already inlines xterm.css.
        if (!globalThis.__inlineStyles) {
          const link = document.createElement("link")
          link.rel = "stylesheet"
          link.href = "./vendor/xterm.css"
          document.head.appendChild(link)
        }

        term = new Terminal({
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 13,
          lineHeight: 1.2,
          cursorBlink: true,
          scrollback: 5000,
          theme: {
            background: "#0a0b0d",
            foreground: "#e8eaed",
            cursor: "#7c9cff",
            cursorAccent: "#0a0b0d",
            selectionBackground: "#24303f",
            black: "#0a0b0d",
            brightBlack: "#5b6068",
          },
        })
        fitAddon = new FitAddon()
        term.loadAddon(fitAddon)
        term.open($("terminal"))
        fitAddon.fit()

        term.onData((data) => {
          if (!ptyID) return
          oc.call("ptyInput", { ptyID, data })
        })

        globalThis.addEventListener("resize", () => {
          try {
            fitAddon?.fit()
          } catch {}
        })
        return term
      }

      async function startShell() {
        if (!connected) return
        const terminal = await ensureTerminal()
        shellStatus("memulai…", "")

        if (ptyID) await call("ptyClose", { ptyID }).catch(() => null)

        const kind = $("shellKind").value
        const input = { title: "opencode-wasm shell", args: [] }
        if (kind) input.command = kind
        const cwd = $("shellCwd").value.trim()
        if (cwd) input.cwd = cwd

        const created = await call("ptyCreate", input)
        ptyID = created?.ptyID
        if (!ptyID) {
          shellStatus("gagal", "err")
          terminal.writeln(`\r\n\x1b[31mgagal membuat shell: ${JSON.stringify(created)}\x1b[0m`)
          return
        }

        const attached = await call("ptyConnect", { ptyID })
        if (attached?.ok === false) {
          shellStatus("gagal", "err")
          terminal.writeln(
            "\r\n\x1b[31msocket shell ditolak.\x1b[0m " +
              (location.protocol === "https:"
                ? "Browser mungkin memblokir ws:// dari halaman HTTPS. Arahkan server lewat wss:// (mis. cloudflared atau ngrok), atau buka halamannya lewat http://."
                : "Coba tombol Mulai ulang."),
          )
          return
        }
        shellStatus(`shell ${ptyID.slice(0, 10)}…`, "on")
        terminal.focus()
      }

      /* ---------- state ---------- */

      function setBusy(busy) {
        $("send").disabled = busy || !connected
        $("prompt").disabled = busy || !connected
        $("send").textContent = busy ? "…" : "Kirim"
      }

      function setConnected(value, label, kind) {
        connected = value
        const status = $("status")
        status.className = `status ${kind ?? ""}`
        $("statusText").textContent = label
        $("model").disabled = !value
        // The connect card is removed once connected, so the button may be gone.
        const button = $("connect")
        if (button) button.disabled = value
        setBusy(false)
      }

      const call = (method, payload = null) =>
        new Promise((resolve, reject) => waiting.set(oc.call(method, payload), { resolve, reject }))

      /* ---------- model picker ---------- */

      const isFree = (model) => (model.cost ?? []).every((c) => !c.input && !c.output && !c.cache?.read)
      const isDeprecated = (model) => model.status === "deprecated"

      function fillModels(list) {
        const picker = $("model")
        picker.innerHTML = ""
        models.clear()

        // The full models.dev catalogue can run into thousands of entries, so
        // show the free ones plus the curated provider, capped for the DOM.
        // Models the server flags as deprecated are hidden by default.
        const curated = list.filter((m) => m.providerID === "opencode")
        const usable = [...new Map([...list.filter(isFree), ...curated].map((m) => [`${m.providerID}/${m.id}`, m])).values()]
          .filter((m) => !isDeprecated(m))
          .slice(0, 250)

        const sorted = [...usable].sort((a, b) => {
          const free = Number(isFree(b)) - Number(isFree(a))
          return free !== 0 ? free : a.id.localeCompare(b.id)
        })

        const groups = new Map()
        for (const model of sorted) {
          const key = model.providerID ?? "other"
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key).push(model)
          models.set(`${model.providerID}/${model.id}`, model)
        }

        for (const [provider, items] of groups) {
          const group = document.createElement("optgroup")
          group.label = provider
          for (const model of items) {
            const option = document.createElement("option")
            option.value = `${model.providerID}/${model.id}`
            option.textContent = model.name
            group.appendChild(option)
          }
          picker.appendChild(group)
        }
        picker.title = `${models.size} dari ${list.length} model`

        const saved = localStorage.getItem("opencode-model")
        // A previously chosen model may have become deprecated; fall back cleanly.
        if (saved && models.has(saved)) picker.value = saved
        if (!picker.value) picker.value = picker.options[0]?.value ?? ""
        return picker.value
      }

      /** Preselect the model the server is configured to use, if we know it. */
      function preselect(defaultKey) {
        const picker = $("model")
        if (localStorage.getItem("opencode-model")) return
        if (defaultKey && models.has(defaultKey)) picker.value = defaultKey
        else if (!picker.value) picker.value = picker.options[0]?.value ?? ""
      }

      const chosenModel = () => {
        const key = $("model").value
        const model = models.get(key)
        return model ? { id: model.id, providerID: model.providerID } : null
      }

      /* ---------- flow ---------- */

      async function startSession(model) {
        const session = await call("createSession", model ? { model } : {})
        sessionID = session?.id ?? session?.sessionID ?? null
        oc.remember(sessionID ?? "")
        $("sessionMeta").textContent = sessionID ? `ses ${sessionID.slice(0, 12)}…` : ""
        await call("subscribe", {})
      }

      async function connect() {
        const url = $("url").value.trim() || "http://127.0.0.1:4096"
        localStorage.setItem(SERVER_KEY, url)
        setConnected(false, "menyambung…", "")
        try {
          await call("open", { baseUrl: url })
          const list = (await call("models"))?.data ?? []
          fillModels(list)

          let defaultKey = null
          try {
            defaultKey = (await call("config"))?.model ?? null
          } catch {
            /* older builds have no config route; fall back to the first entry */
          }
          preselect(defaultKey)

          thread.innerHTML = ""
          await startSession(chosenModel())
          setConnected(true, "tersambung", "on")
          system(`terhubung ke ${url} · ${$("model").title}`)
          if (document.body.classList.contains("shell")) await startShell()        } catch (err) {
          setConnected(false, "gagal", "err")
          console.error("[opencode-wasm] connect failed", err)
          add("error", err?.message ?? String(err))
        }
      }

      const SERVER_KEY = "opencode-server"

      /** Server URL: ?server= wins, then the last one used, then localhost. */
      function defaultServerURL() {
        const fromQuery = new URLSearchParams(location.search).get("server")
        if (fromQuery) {
          localStorage.setItem(SERVER_KEY, fromQuery)
          return fromQuery
        }
        return localStorage.getItem(SERVER_KEY) ?? "http://127.0.0.1:4096"
      }

      function showConnectCard() {
        const saved = defaultServerURL()
        thread.innerHTML = `
          <div class="card">
            <h2>Sambungkan ke server opencode</h2>
            <p>Runtime agent berjalan di server; klien resminya ada di dalam file wasm ini.</p>
            <div class="row">
              <input id="url" value="${saved.replace(/"/g, "&quot;")}" spellcheck="false" />
              <button id="connect" class="primary">Sambung</button>
            </div>
            <p class="hint" id="connectHint"></p>
          </div>`
        $("connect").onclick = connect
        $("url").onkeydown = (e) => e.key === "Enter" && connect()

        // Pages is HTTPS, so a plain ws:// PTY socket is blocked as mixed content.
        if (location.protocol === "https:" && saved.startsWith("http://")) {
          $("connectHint").innerHTML =
            "Halaman ini HTTPS dan server-nya <code>http://</code>. Chromium mengizinkan ini untuk <code>localhost</code>; browser lain bisa lebih ketat — siapkan <code>wss://</code> kalau shell tidak mau tersambung."
        }
      }

      async function send() {
        const text = $("prompt").value.trim()
        if (!text || !sessionID) return
        add("user", text)
        $("prompt").value = ""
        stepShown = false
        setBusy(true)
        try {
          await call("prompt", { sessionID, text })
        } catch (err) {
          setBusy(false)
          add("error", err.message)
        }
      }

      async function switchModel() {
        const model = chosenModel()
        localStorage.setItem("opencode-model", $("model").value)
        if (!sessionID || !model) return
        try {
          await call("switchModel", { sessionID, model })
        } catch (err) {
          add("error", err.message)
        }
      }

      /* ---------- boot ---------- */

      oc = await bootOpenCode()
      $("runtimeMeta").textContent = `runtime tertanam ${kb(oc.embeddedBytes)}`
      showConnectCard()

      oc.on("event", onEvent)

      oc.on("reply", ({ ticket, ok, data, error }) => {
        const pending = waiting.get(ticket)
        if (pending) {
          waiting.delete(ticket)
          ok ? pending.resolve(data) : pending.reject(new Error(error))
        }
        const s = oc.stats()
        $("counterMeta").textContent = `queued ${s.queued} · replies ${s.replies} · events ${s.events}`
      })

      $("send").onclick = send
      $("prompt").onkeydown = (e) => {
        if (e.key === "Enter") send()
      }
      $("model").onchange = switchModel

      $("autoAllow").setAttribute("aria-pressed", String(autoAllow))
      $("autoAllow").onclick = () => {
        autoAllow = !autoAllow
        localStorage.setItem("opencode-auto-allow", String(autoAllow))
        $("autoAllow").setAttribute("aria-pressed", String(autoAllow))
      }

      $("tabChat").onclick = () => showTab("chat")
      $("tabShell").onclick = () => showTab("shell")
      $("tabWeb").onclick = () => showTab("web")
      $("shellRestart").onclick = startShell
      $("shellClear").onclick = () => term?.clear()

      $("webBack").onclick = () => step(-1)
      $("webFwd").onclick = () => step(1)
      $("webReload").onclick = () => openInPanel($("webUrl").value, { push: false })
      $("webExternal").onclick = () => window.open($("webUrl").value, "_blank", "noopener")
      $("webUrl").onkeydown = (e) => {
        if (e.key === "Enter") openInPanel($("webUrl").value)
      }
      for (const button of document.querySelectorAll("#webEmpty [data-url]")) {
        button.onclick = () => openInPanel(button.dataset.url)
      }

      // Best effort: detach the websocket when the page goes away.
      globalThis.addEventListener("pagehide", () => {
        if (!ptyID) return
        const ticket = oc.call("ptyClose", { ptyID })
        waiting.delete(ticket)
      })
