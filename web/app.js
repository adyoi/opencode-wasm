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

      // Escaping for the few places that build HTML from values that can come
      // from a URL: `?server=` and the remembered address are attacker-supplied,
      // and both end up inside innerHTML in the connect card and its hints.
      const esc = (value) =>
        String(value ?? "").replace(
          /[&<>"']/g,
          (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
        )

      /**
       * Streaming appends a delta per token, and every append used to force a
       * synchronous layout. One scroll per animation frame is enough for a human
       * to read, and a hidden tab gets it applied straight away because no frame
       * is coming.
       */
      let scrollQueued = false
      const scroll = () => {
        const visible = typeof document === "undefined" || document.visibilityState === "visible"
        if (!visible) {
          main.scrollTop = main.scrollHeight
          return
        }
        if (scrollQueued) return
        scrollQueued = true
        const run = () => {
          scrollQueued = false
          main.scrollTo({ top: main.scrollHeight })
        }
        if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(run)
        else run()
      }

      /**
       * A long session emits thousands of messages and tool calls, and nothing
       * reads either entry once its turn is over. Drop the oldest so a day-long
       * session does not grow the page's memory without bound.
       */
      const TRACKED = 500
      const remember = (map, key, value) => {
        map.set(key, value)
        if (map.size > TRACKED) map.delete(map.keys().next().value)
      }

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
        // Always a string: every branch ends in one, so the caller can assign it
        // straight to textContent.
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
        node.querySelector(".args").textContent = detail
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

      const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"]

      /** The address the page is actually trying to reach. */
      function currentServerURL() {
        const field = document.getElementById("url")
        return (field?.value ?? localStorage.getItem("opencode-server") ?? "").trim()
      }

      const hostOf = (url) => {
        try {
          return new URL(url).hostname
        } catch {
          return ""
        }
      }

      /** Turn transport/CORS noise into something a person can act on. */
      function explain(err) {
        const message = err?.message ?? String(err)
        if (/UnauthorizedError|Authentication required|\b401\b/i.test(message)) {
          return "Server minta autentikasi. Isi kolom password di kartu Sambung (user default: opencode)."
        }
        if (/Failed to fetch|Transport: Failed to fetch|NetworkError|Load failed/i.test(message)) {
          const target = currentServerURL()
          const host = hostOf(target)
          const isLoopback = LOOPBACK.includes(host)
          const httpsPage = location.protocol === "https:"
          const cors = httpsPage && !LOOPBACK.includes(location.hostname)
            ? `opencode serve --port 4096 --cors ${location.origin}`
            : "opencode serve --port 4096"

          const notes = [
            "Tidak bisa menghubungi server.",
            `Alamat yang dicoba: ${target || "(kosong)"}`,
            "Coba cek: (1) opencode serve masih jalan, (2) portnya benar, (3) origin halaman ini ada di --cors.",
            `contoh: ${cors}`,
          ]

          if (isLoopback && !LOOPBACK.includes(location.hostname)) {
            notes.push(
              `Halaman ini dibuka dari ${location.hostname}, jadi ${host} menunjuk ke perangkat ini — bukan ke mesin tempat server berjalan. Dari perangkat lain, pakai IP LAN.`,
            )
          }
          if (!isLoopback && host) {
            notes.push(
              `${host} hanya menjawab kalau servernya dijalankan dengan --hostname 0.0.0.0 (default 127.0.0.1 hanya untuk komputer ini). Cek juga firewall dan Wi-Fi yang memblokir perangkat antar-jaringan.`,
            )
          }
          if (httpsPage && target.startsWith("http://")) {
            notes.push(
              isLoopback
                ? "Halaman ini HTTPS dan server-nya http://. Chromium mengizinkan ini untuk localhost; browser lain bisa lebih ketat."
                : "Halaman ini HTTPS dan servernya http:// di alamat jaringan pribadi — browser sering memblokirnya. Pakai https:// (Codespaces atau tunnel), atau buka halamannya lewat http://.",
            )
          }
          notes.push("Kalau browser meminta izin jaringan lokal untuk situs ini, setujui dulu (ikon kunci di address bar).")
          return notes.join("\n")
        }
        return message
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
            remember(bubbles, id, streaming)
            caret(true)
            break
          }

          case "session.text.delta": {
            const id = data.assistantMessageID || data.messageID || "last"
            const entry = bubbles.get(id) ?? (streaming ?? add("assistant", ""))
            remember(bubbles, id, entry)
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
            remember(toolState, data.callID || data.tool, toolLine(data))
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
              // Clear the id, otherwise the shell tab believes a live shell is
              // still attached and never starts a replacement.
              ptyID = null
              shellStatus("selesai", data.error ? "err" : "")
              if (term) term.writeln(`\r\n\x1b[90m[shell ditutup${data.error ? `: ${data.error}` : ""}]\x1b[0m`)
            }
            break

          default:
            // Keystrokes and the terminal text are dropped by pty.output, so the
            // last-event line gets its own node: it used to be appended to the
            // same node the reply handler rewrote, and the two kept erasing each
            // other's text.
            $("lastEvent").textContent = `last: ${type}`
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

      const TABS = { chat: "tabChat", shell: "tabShell", web: "tabWeb" }
      const TAB_ORDER = ["chat", "shell", "web"]

      async function showTab(name) {
        document.body.classList.toggle("shell", name === "shell")
        document.body.classList.toggle("web", name === "web")
        // Roving tabindex: only the selected tab is in the tab order, which is
        // what the arrow-key handler below relies on to move between them.
        for (const tab of TAB_ORDER) {
          const button = $(TABS[tab])
          button.setAttribute("aria-selected", String(tab === name))
          button.tabIndex = tab === name ? 0 : -1
        }

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
        const terminal = await ensureTerminal()
        shellStatus("memulai…", "")

        const fail = (message) => {
          shellStatus("gagal", "err")
          terminal.writeln(`\r\n\x1b[31mshell gagal.\x1b[0m ${message}`)
        }

        if (!connected) {
          fail("Belum terhubung ke server. Sambungkan dulu lewat tombol Sambung.")
          return
        }

        try {
          if (ptyID) await call("ptyClose", { ptyID }).catch(() => null)

          const kind = $("shellKind").value
          const input = { title: "opencode-wasm shell", args: [] }
          if (kind) input.command = kind
          const cwd = $("shellCwd").value.trim()
          if (cwd) input.cwd = cwd

          const created = await call("ptyCreate", input)
          ptyID = created?.ptyID
          if (!ptyID) {
            fail(`server tidak mengembalikan PTY: ${JSON.stringify(created)}`)
            return
          }

          const attached = await call("ptyConnect", { ptyID })
          if (attached?.ok === false) {
            fail(
              location.protocol === "https:"
                ? "Browser mungkin memblokir ws:// dari halaman HTTPS. Arahkan server lewat wss:// (mis. cloudflared atau ngrok), atau buka halamannya lewat http://."
                : "Coba tombol Mulai ulang.",
            )
            return
          }
          shellStatus(`shell ${ptyID.slice(0, 10)}…`, "on")
          terminal.focus()
        } catch (err) {
          const message = String(err?.message ?? err)
          if (/AUTH_WS_UNSUPPORTED/.test(message)) {
            fail(
              localStorage.getItem(CRED_KEY)
                ? "Browser memakai kredensial yang tersimpan di halaman ini, dan WebSocket tidak bisa mengirim header Authorization. Kosongkan kolom pengguna/password di kartu Sambung lalu sambungkan lagi — shell bisa jalan kalau server-nya tanpa password."
                : "Server memakai password. Browser tidak bisa mengirim header Authorization ke WebSocket, jadi shell tidak bisa — butuh server tanpa password, atau reverse proxy yang menyisipkan header.",
            )
          } else {
            fail(explain(err))
          }
        }
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
        // Both controls are session settings, so both follow the connection.
        // The agent control is absent on servers without /agent.
        $("model").disabled = !value
        const agentPicker = $("agent")
        if (agentPicker) agentPicker.disabled = !value
        const variantPicker = $("variant")
        if (variantPicker) variantPicker.disabled = !value || variantPicker.hidden
        // The pill is the disconnect control online and the rescan trigger
        // offline, so it stays actionable in both states.
        status.classList.toggle("offline", !value)
        status.setAttribute("aria-disabled", "false")
        status.tabIndex = 0
        status.title = value ? "Klik untuk memutus sambungan ke server" : "Klik untuk mencari server lagi"
        // The connect card is removed once connected, so the button may be gone.
        const button = $("connect")
        if (button) button.disabled = value
        setBusy(false)
      }

      const call = (method, payload = null) =>
        new Promise((resolve, reject) => waiting.set(oc.call(method, payload), { resolve, reject }))

      /* ---------- model picker ---------- */

      /**
       * A model counts as free when nothing about it costs anything.
       *
       * `cost` has been both shapes in the wild: an array of tiers and a single
       * pricing object, and the API schema still calls it an object. Assuming
       * one of them made the whole model list throw on a server that sent the
       * other.
       */
      const isFree = (model) => {
        const cost = model.cost
        if (cost == null) return true
        const free = (tier) => !tier.input && !tier.output && !tier.cache?.read
        return Array.isArray(cost) ? cost.every(free) : free(cost)
      }
      const isDeprecated = (model) => model.status === "deprecated"

      // Two pickers, like the desktop client: one says *who* answers, the other
      // says *with what*. They are independent server settings, and keeping them
      // in one list made picking a model look like it picked an agent too.
      const AGENT_KEY = "opencode-agent"
      const MODEL_KEY = "opencode-model"
      const VARIANTS_KEY = "opencode-variants"
      const DEFAULT_AGENT = "default"

      /** Pipeline-internal agents: never offered, they are not user choices. */
      const HIDDEN_AGENTS = new Set(["compaction", "summary", "title"])

      /**
       * An earlier build kept agents and models in one list, under an "agent:"
       * prefix in the same localStorage key. Move that choice to the agent
       * control instead of leaving a value behind that no option can match —
       * which would also have suppressed preselectModel() and pinned the
       * session to whatever model happened to be listed first.
       */
      function migrateStoredSelection() {
        const saved = localStorage.getItem(MODEL_KEY)
        if (!saved?.startsWith("agent:")) return
        const agent = saved.slice("agent:".length)
        if (agent !== DEFAULT_AGENT && !localStorage.getItem(AGENT_KEY)) localStorage.setItem(AGENT_KEY, agent)
        localStorage.removeItem(MODEL_KEY)
      }

      function fillAgents(agentList = []) {
        const picker = $("agent")
        picker.innerHTML = ""
        // "default" means: send nothing and let the server's own configuration
        // decide. It has to be the first entry so a fresh visit starts the way
        // the server is configured rather than the way this page guesses.
        const agents = agentList.filter((a) => !a.hidden && !HIDDEN_AGENTS.has(a.id) && a.id !== DEFAULT_AGENT)
        if (!agents.length) {
          // No /agent route on this server: the control would have nothing to
          // offer, so it is removed rather than left as an empty dead box.
          picker.remove()
          return null
        }
        for (const agent of [{ id: DEFAULT_AGENT, description: "Ikuti konfigurasi server" }, ...agents]) {
          const option = document.createElement("option")
          option.value = agent.id
          option.textContent = agent.id
          option.title = agent.description ?? ""
          picker.appendChild(option)
        }
        picker.title = "Agent"

        const saved = localStorage.getItem(AGENT_KEY)
        picker.value = agents.some((a) => a.id === saved) ? saved : DEFAULT_AGENT
        return picker.value
      }

      function fillModels(list) {
        const picker = $("model")
        picker.innerHTML = ""
        models.clear()

        // The full models.dev catalogue can run into thousands of entries, so
        // keep the free ones plus the curated provider, then cap for the DOM.
        // Models the server flags as deprecated are hidden by default.
        const curated = list.filter((m) => m.providerID === "opencode")
        const candidates = [...new Map([...list.filter(isFree), ...curated].map((m) => [`${m.providerID}/${m.id}`, m])).values()].filter(
          (m) => !isDeprecated(m),
        )

        // Sort before capping. Capping first threw away whatever the catalogue
        // happened to list late, free models included, purely because of the
        // order the server returned them in.
        const sorted = candidates
          .sort((a, b) => {
            const free = Number(isFree(b)) - Number(isFree(a))
            return free !== 0 ? free : a.id.localeCompare(b.id)
          })
          .slice(0, 250)

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
        picker.title = `${models.size} dari ${candidates.length} lolos filter · ${list.length} dari server`

        // A previously chosen model may have become deprecated; fall back cleanly.
        const saved = localStorage.getItem(MODEL_KEY)
        if (saved && models.has(saved)) picker.value = saved
        if (!picker.value) picker.value = picker.options[0]?.value ?? ""
        return picker.value
      }

      /**
       * Variants live on the effective provider config, not on /api/model.
       * /api/model ships `"variants": []` for every entry even when the model
       * really has low/medium/high, so /config/providers is the only place they
       * show up. Merging them in here means one lookup wherever a model is read.
       */
      async function loadVariants() {
        const out = await call("configProviders")
          .then((out2) => out2?.providers ?? out2?.data?.providers ?? null)
          .catch(() => null)
        if (!out) return 0
        let found = 0
        for (const provider of Object.values(out)) {
          for (const [id, model] of Object.entries(provider?.models ?? {})) {
            const variants = model?.variants
            if (!variants || !Object.keys(variants).length) continue
            const entry = models.get(`${provider.id}/${id}`)
            if (!entry) continue
            entry.variants = variants
            found++
          }
        }
        return found
      }

      /** Preselect the model the server is configured to use, if we know it. */
      function preselectModel(defaultKey) {
        const picker = $("model")
        // Presetting can move the picker, so the variant list is rebuilt after.
        if (!localStorage.getItem(MODEL_KEY) && defaultKey && models.has(defaultKey)) picker.value = defaultKey
        fillVariants()
      }

      /* ---------- variants ---------- */

      /** `{ "provider/id": "high" }`, so a per-model choice survives switching. */
      function rememberedVariants() {
        try {
          return JSON.parse(localStorage.getItem(VARIANTS_KEY) ?? "{}") ?? {}
        } catch {
          return {}
        }
      }

      function rememberVariant(modelKey, variant) {
        const all = rememberedVariants()
        if (variant) all[modelKey] = variant
        else delete all[modelKey]
        try {
          localStorage.setItem(VARIANTS_KEY, JSON.stringify(all))
        } catch {
          /* a remembered variant is a nicety, never a reason to break the page */
        }
      }

      /**
       * Variants are declared per model (`model.variants`), and most free models
       * declare none. When there is nothing to pick the control is hidden rather
       * than left as an empty box, so the footer only grows when it means
       * something.
       */
      function fillVariants() {
        const picker = $("variant")
        const model = models.get($("model").value)
        const variants = model?.variants ?? {}
        const names = Object.keys(variants)

        picker.innerHTML = ""
        if (!names.length) {
          picker.hidden = true
          picker.value = ""
          return null
        }

        picker.hidden = false
        const options = [{ value: "", label: "default", title: "Tanpa varian tambahan" }]
        for (const name of names) {
          const detail = variants[name] ?? {}
          // Real variants look like { reasoningEffort: "high" }; a configured one
          // can carry a name or a description instead.
          const title = detail.description ?? (detail.reasoningEffort ? `reasoningEffort: ${detail.reasoningEffort}` : name)
          options.push({ value: name, label: detail.name ?? name, title })
        }
        for (const option of options) {
          const node = document.createElement("option")
          node.value = option.value
          node.textContent = option.label
          // Assigning undefined here would stringify to the text "undefined".
          node.title = option.title ?? ""
          picker.appendChild(node)
        }
        picker.title = "Varian dari model yang dipilih"

        const remembered = rememberedVariants()[$("model").value]
        picker.value = names.includes(remembered) ? remembered : ""
        return picker.value
      }

      const chosenAgent = () => {
        const picker = $("agent")
        // The control is removed on servers without /agent; there is nothing
        // to choose then, and the session simply uses the server default.
        const agent = picker?.value && picker.value !== DEFAULT_AGENT ? picker.value : null
        return agent
      }

      const chosenModel = () => {
        const model = models.get($("model").value)
        return model ? { id: model.id, providerID: model.providerID } : null
      }

      const chosenVariant = () => $("variant")?.hidden ? null : $("variant").value || null

      /** A `ModelRef`: id + provider, plus the variant when one is picked. */
      function modelRef() {
        const model = chosenModel()
        if (!model) return null
        const variant = chosenVariant()
        return variant ? { ...model, variant } : model
      }

      /** Body for `createSession`; "default" leaves the key out entirely. */
      function sessionInput() {
        const input = {}
        const agent = chosenAgent()
        const model = modelRef()
        if (agent) input.agent = agent
        if (model) input.model = model
        return input
      }

      /** Short description of the current pick, for the connect banner. */
      function selectionSummary() {
        const parts = []
        const agent = chosenAgent()
        parts.push(agent ?? "default")
        const model = modelRef()
        if (model) parts.push(model.variant ? `${model.id}/${model.variant}` : model.id)
        return parts.join(" · ")
      }

      /* ---------- flow ---------- */

      async function startSession() {
        const session = await call("createSession", sessionInput())
        sessionID = session?.id ?? session?.sessionID ?? null
        oc.remember(sessionID ?? "")
        $("sessionMeta").textContent = sessionID ? `ses ${sessionID.slice(0, 12)}…` : ""
        await call("subscribe", {})
      }

      const CRED_KEY = "opencode-credentials"

      const basicHeader = (username, password) =>
        `Basic ${btoa(`${username || "opencode"}:${password}`)}`

      /**
       * Credentials live in sessionStorage, not localStorage: a server password
       * is a secret, and localStorage keeps it on disk for months where any
       * script on the origin can read it. A copy written by an older build is
       * migrated on first read and then deleted, so the plaintext-at-rest version
       * disappears instead of lingering.
       */
      function loadCredentials() {
        let raw = null
        try {
          const legacy = localStorage.getItem(CRED_KEY)
          raw = sessionStorage.getItem(CRED_KEY) ?? legacy
          if (legacy) localStorage.removeItem(CRED_KEY)
        } catch {
          /* private mode / disabled storage: just connect without it */
        }
        try {
          return JSON.parse(raw ?? "null")
        } catch {
          return null
        }
      }

      function saveCredentials(value) {
        try {
          if (value) sessionStorage.setItem(CRED_KEY, JSON.stringify(value))
          else sessionStorage.removeItem(CRED_KEY)
        } catch {
          /* nothing to do; the password is still used for this connection */
        }
      }

      /** Credentials remembered from an earlier visit, used when no card is shown. */
      function storedCredentials() {
        const saved = loadCredentials()
        return { username: saved?.username ?? "", password: saved?.password ?? "" }
      }

      /**
       * `url` may be passed in by the auto-detect, so connecting does not depend
       * on the connect card being on screen. Credentials come from the card when
       * it is there, otherwise from what was remembered last time.
       */
      async function connect(urlOverride = null) {
        const url = (urlOverride ?? $("url")?.value ?? "").trim() || "http://127.0.0.1:4096"
        localStorage.setItem(SERVER_KEY, url)

        const stored = storedCredentials()
        const username = ($("user")?.value ?? "").trim() || stored.username
        const password = $("pass")?.value ?? stored.password
        const headers = password ? { Authorization: basicHeader(username, password) } : {}
        saveCredentials(password ? { username, password } : null)

        setConnected(false, "menyambung…", "")
        try {
          await call("open", { baseUrl: url, headers })
          const list = (await call("models"))?.data ?? []
          // Agents are optional: an older server has no /agent route, and the
          // agent control removes itself rather than sitting there empty.
          const agentList = await call("agents")
            .then((out) => (out?.data ?? out ?? []).filter((a) => a && a.id))
            .catch(() => [])
          migrateStoredSelection()
          fillAgents(agentList)
          fillModels(list)
          await loadVariants()

          let defaultKey = null
          try {
            defaultKey = (await call("config"))?.model ?? null
          } catch {
            /* older builds have no config route; fall back to the first entry */
          }
          preselectModel(defaultKey)

          thread.innerHTML = ""
          await startSession()
          setConnected(true, "tersambung", "on")
          system(`terhubung ke ${url} · ${selectionSummary()}`)
          if (document.body.classList.contains("shell")) await startShell()
        } catch (err) {
          setConnected(false, "gagal", "err")
          console.error("[opencode-wasm] connect failed", err)
          add("error", explain(err))
        }
      }

      /**
       * Ask first, then disconnect. The status pill is the only disconnect
       * control, so a mis-click on it should not silently drop a live session.
       */
      function confirmDisconnect() {
        if (!connected) return
        const where = localStorage.getItem(SERVER_KEY) ?? "server ini"
        const extra = ptyID ? "\n\nShell yang sedang berjalan ikut ditutup." : ""
        if (!confirm(`Putuskan sambungan ke ${where}?${extra}\n\nServer tetap jalan; sambungkan lagi kapan saja.`)) return
        disconnect()
      }

      /**
       * Putuskan sambungan: tutup shell, hentikan stream event, buang antrean
       * panggilan yang menggantung, lalu kembali ke kartu sambung.
       */
      async function disconnect() {
        // A live shell outlives a lost connection, so the teardown has to run
        // even when the flag already says "not connected" — otherwise the PTY
        // stays alive on the server with nothing left to close it.
        if (!connected && !ptyID) return
        if (ptyID) {
          const closing = ptyID
          ptyID = null
          // The close has to land before the bridge is torn down: oc.close()
          // aborts in-flight fetches, so a fire-and-forget request would be
          // cancelled on its way out and the shell would survive on the server.
          const ticket = oc.call("ptyClose", { ptyID: closing })
          await Promise.race([
            new Promise((resolve, reject) => waiting.set(ticket, { resolve, reject })),
            new Promise((resolve) => setTimeout(resolve, 2000)),
          ]).catch(() => null)
        }
        try {
          // aborts the in-flight fetches and the event stream in one go
          oc.close()
        } catch (err) {
          console.warn("[opencode-wasm] close failed", err)
        }
        // these would otherwise hang forever, since their reply never arrives
        for (const [, pending] of waiting) pending.reject(new Error("terputus"))
        waiting.clear()
        sessionID = null
        $("sessionMeta").textContent = ""
        $("shellStatus").className = "status"
        $("shellStatusText").textContent = "belum jalan"
        setConnected(false, "terputus", "")
        showConnectCard("Sambungan diputus. Server masih jalan selama prosesnya tidak dihentikan.")
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

      function showConnectCard(note = "", detectedURL = null) {
        // A freshly detected address wins over the stored default: re-rendering
        // the card must not throw away what the scan just found.
        const saved = detectedURL ?? defaultServerURL()
        if (detectedURL) localStorage.setItem(SERVER_KEY, detectedURL)
        thread.innerHTML = `
          <div class="card">
            <h2>Sambungkan ke server opencode</h2>
            <p>Runtime agent berjalan di server; klien resminya ada di dalam file wasm ini.</p>
            <div class="row">
              <input id="url" value="${esc(saved)}" spellcheck="false" />
              <button id="connect" class="primary">Sambung</button>
              <button id="rescan" title="Cari server opencode di alamat yang biasa">Cari lagi</button>
            </div>
            <div class="row creds">
              <input id="user" placeholder="pengguna (default: opencode)" autocomplete="username" />
              <input id="pass" type="password" placeholder="password server (kalau ada)" autocomplete="current-password" />
            </div>
            <p class="hint" id="connectHint"></p>
          </div>`
        // A bare reference would hand connect() the click event as urlOverride, and
        // (event ?? value).trim() is not a function.
        $("connect").onclick = () => connect()
        $("rescan").onclick = () => rescan()
        $("url").onkeydown = (e) => e.key === "Enter" && connect()

        const remembered = loadCredentials()
        if (remembered) {
          $("user").value = remembered.username ?? ""
          $("pass").value = remembered.password ?? ""
        }

        // Pages is HTTPS, so a plain ws:// PTY socket is blocked as mixed content.
        const hints = []
        if (note) hints.push(note)
        const servedLocally = ["localhost", "127.0.0.1", ""].includes(location.hostname)
        const savedHost = hostOf(saved)
        const savedIsLoopback = LOOPBACK.includes(savedHost)
        if (!servedLocally && savedIsLoopback) {
          hints.push(
            `Halaman ini dibuka dari <code>${esc(location.hostname)}</code>, jadi <code>${esc(savedHost)}</code> menunjuk ke komputer ini — bukan ke mesin tempat server berjalan. Buka dari komputer yang sama, atau isi URL server yang bisa dijangkau.`,
          )
        }
        if (!servedLocally && !savedIsLoopback && savedHost) {
          hints.push(
            `<code>${esc(savedHost)}</code> hanya menjawab kalau servernya dijalankan dengan <code>--hostname 0.0.0.0</code>. Kalau tidak, pakai <code>127.0.0.1</code> dari komputer yang sama.`,
          )
        }
        if (location.protocol === "https:" && saved.startsWith("http://")) {
          hints.push(
            savedIsLoopback
              ? "Halaman ini HTTPS dan server-nya <code>http://</code>. Chromium mengizinkan ini untuk <code>localhost</code>; browser lain bisa lebih ketat — siapkan <code>wss://</code> kalau shell tidak mau tersambung."
              : "Halaman ini HTTPS dan servernya <code>http://</code> di alamat jaringan pribadi — browser sering memblokirnya. Pakai <code>https://</code> (Codespaces atau tunnel), atau buka halamannya lewat <code>http://</code>.",
          )
        }
        if (hints.length) $("connectHint").innerHTML = hints.join("<br><br>")
      }

      /* ---------- menemukan server sendiri ---------- */

      const PROBE_TIMEOUT = 1500
      const PROBE_PORTS = [4096]

      /**
       * Is there an opencode server at this address?
       *
       * A 401 still counts as "the server is there" — that is exactly the state a
       * password-protected server is in, and treating it as "nothing here" would
       * hide the server from the auto-detect. Only a failed request means absent.
       */
      async function probe(baseUrl) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT)
        try {
          const res = await fetch(`${baseUrl.replace(/\/$/, "")}/global/health`, {
            signal: controller.signal,
          })
          if (res.status === 401 || res.status === 403) return { ok: true, needsAuth: true }
          if (!res.ok) return { ok: false, needsAuth: false }
          const body = await res.json().catch(() => null)
          const healthy = body?.healthy === true || body?.healthy === "true"
          return { ok: healthy, needsAuth: false }
        } catch {
          return { ok: false, needsAuth: false }
        } finally {
          clearTimeout(timer)
        }
      }

      /**
       * Addresses worth trying, best first: whatever the URL asked for, whatever
       * worked last time, then this host on the usual opencode ports. Using the
       * page's own hostname is what makes a LAN address work without typing it.
       */
      function candidateServers() {
        const list = []
        const query = new URLSearchParams(location.search).get("server")
        const saved = localStorage.getItem(SERVER_KEY)
        if (query) list.push(query)
        if (saved) list.push(saved)

        // Keep any port the ?server= URL already used, then the common ones.
        let port = ""
        try {
          port = query ? new URL(query).port : ""
        } catch {
          /* a malformed ?server= is not worth guessing from */
        }

        const hosts = []
        // The page's own hostname is only worth probing when the page itself is
        // plain http. Over HTTPS every request to it is mixed content and gets
        // blocked before it leaves, which on GitHub Pages means a guaranteed
        // miss plus a console warning on every load.
        if (location.hostname && location.protocol !== "https:") hosts.push(location.hostname)
        for (const host of ["127.0.0.1", "localhost"]) if (!hosts.includes(host)) hosts.push(host)
        for (const host of hosts) {
          // The borrowed port only means something for a host we know how to
          // reach the server on. Applied to the page's own hostname it invented
          // addresses like http://adyoi.github.io:4097, which nothing listens on
          // and which the browser rejects as mixed content on an HTTPS page.
          if (port && port !== "4096" && LOOPBACK.includes(host)) list.push(`http://${host}:${port}`)
          for (const p of PROBE_PORTS) list.push(`http://${host}:${p}`)
        }
        return [...new Set(list)]
      }

      /** Probe every candidate at once and return the first that answers. */
      async function discover() {
        const candidates = candidateServers()
        const results = await Promise.all(candidates.map(async (url) => ({ url, ...(await probe(url)) })))
        return results.find((r) => r.ok) ?? null
      }

      /**
       * Look for a running server and connect to it. The connect card only
       * appears when something needs the visitor to act: no server at all, or a
       * server that wants a password.
       */
      async function rescan({ quiet = false } = {}) {
        const button = $("rescan")
        if (button) {
          button.disabled = true
          button.textContent = "mencari…"
        }
        if (!connected) setConnected(false, "mencari server…", "")

        const fromQuery = new URLSearchParams(location.search).get("server")
        const found = await discover()
        const field = $("url")
        if (button) {
          button.disabled = false
          button.textContent = "Cari lagi"
        }

        if (!found) {
          if (!connected) setConnected(false, "offline", "")
          if (!quiet) {
            showConnectCard(
              "Tidak menemukan server opencode di alamat yang biasa. Pastikan <code>opencode serve</code> jalan, lalu tekan <b>Sambung</b> atau <b>Cari lagi</b>.",
            )
          }
          return null
        }

        if (field) field.value = found.url
        if (found.needsAuth) {
          // A 401 is a server, just not an open one. If this browser already
          // remembers a password, try it before asking for one again.
          if (storedCredentials().password) {
            await connect(found.url)
            if (connected) return found.url
          }
          if (!connected) setConnected(false, "butuh password", "")
          showConnectCard(
            `Server ditemukan di <code>${esc(found.url)}</code>, tapi ia memakai password. Isi kolom di bawah lalu tekan <b>Sambung</b>.`,
            found.url,
          )
          return found.url
        }

        if (connected) return found.url
        await connect(found.url)
        if (!fromQuery) system(`server ditemukan otomatis di ${found.url}`)
        return found.url
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

      /**
       * Push the agent control's new value onto the running session.
       */
      async function switchAgent() {
        const agent = $("agent")?.value ?? DEFAULT_AGENT
        // "default" is not remembered as a choice: it is what a fresh visit
        // gets anyway, and storing it would only make "no preference" sticky.
        if (agent === DEFAULT_AGENT) localStorage.removeItem(AGENT_KEY)
        else localStorage.setItem(AGENT_KEY, agent)
        if (!sessionID) return
        if (agent === DEFAULT_AGENT) {
          // The API has no "unset": every route wants a concrete agent name,
          // so "default" can only be honoured by the next session.
          system("agent → default · berlaku untuk sesi berikutnya")
          return
        }
        try {
          await call("setAgent", { sessionID, agent })
          system(`agent → ${agent}`)
        } catch (err) {
          add("error", err.message)
        }
      }

      /** Push the model control's new value onto the running session. */
      async function switchModel() {
        localStorage.setItem(MODEL_KEY, $("model").value)
        // The variant list belongs to the model, so it has to be rebuilt before
        // the ModelRef is built — otherwise the old variant would be sent along
        // with the new model.
        fillVariants()
        const model = modelRef()
        if (!sessionID || !model) return
        try {
          await call("switchModel", { sessionID, model })
        } catch (err) {
          add("error", err.message)
        }
      }

      /**
       * Push a variant change. The API has no variant-only route: variants ride
       * along on the ModelRef, so this re-sends the model with the new variant.
       */
      async function switchVariant() {
        const modelKey = $("model").value
        rememberVariant(modelKey, $("variant").value)
        const model = modelRef()
        if (!sessionID || !model) return
        try {
          await call("switchModel", { sessionID, model })
          system(`varian → ${model.variant}`)
        } catch (err) {
          add("error", err.message)
        }
      }

      /* ---------- boot ---------- */

      oc = await bootOpenCode()
      $("runtimeMeta").textContent = `runtime tertanam ${kb(oc.embeddedBytes)}`
      // No connect card up front: the scan runs immediately and the card only
      // appears if there is nothing to connect to, or a password is needed.
      thread.innerHTML = `<div class="msg system"><div class="body">mencari server opencode…</div></div>`
      setConnected(false, "mencari server…", "")

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
      // The status pill is the disconnect control when online, and the way to
      // look for a server again when offline.
      $("status").onclick = () => (connected ? confirmDisconnect() : rescan())
      $("status").onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          connected ? confirmDisconnect() : rescan()
        }
      }
      $("prompt").onkeydown = (e) => {
        if (e.key === "Enter") send()
      }
      $("agent").onchange = switchAgent
      $("model").onchange = switchModel
      $("variant").onchange = switchVariant

      $("autoAllow").setAttribute("aria-pressed", String(autoAllow))
      $("autoAllow").onclick = () => {
        autoAllow = !autoAllow
        localStorage.setItem("opencode-auto-allow", String(autoAllow))
        $("autoAllow").setAttribute("aria-pressed", String(autoAllow))
      }

      $("tabChat").onclick = () => showTab("chat")
      $("tabShell").onclick = () => showTab("shell")
      $("tabWeb").onclick = () => showTab("web")
      // Arrow keys move between tabs, as the tablist pattern expects. Without this
      // only the Chat tab was reachable by keyboard.
      document.querySelector(".tabs").onkeydown = (e) => {
        const current = TAB_ORDER.find((tab) => TABS[tab] === e.target.id) ?? "chat"
        const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key]
        let next = null
        if (step !== undefined) next = (TAB_ORDER.indexOf(current) + step + TAB_ORDER.length) % TAB_ORDER.length
        else if (e.key === "Home") next = 0
        else if (e.key === "End") next = TAB_ORDER.length - 1
        if (next === null) return
        e.preventDefault()
        showTab(TAB_ORDER[next])
        $(TABS[TAB_ORDER[next]]).focus()
      }
      $("shellRestart").onclick = startShell
      $("shellClear").onclick = () => term?.clear()

      $("webBack").onclick = () => step(-1)
      $("webFwd").onclick = () => step(1)
      $("webReload").onclick = () => openInPanel($("webUrl").value, { push: false })
      $("webGo").onclick = () => openInPanel($("webUrl").value)
      $("webUrl").onkeydown = (e) => {
        if (e.key === "Enter") openInPanel($("webUrl").value)
      }
      for (const button of document.querySelectorAll("#webEmpty [data-url]")) {
        button.onclick = () => openInPanel(button.dataset.url)
      }

      // Best effort: detach the websocket when the page goes away. This calls the
      // embedded runtime directly instead of queueing a request: by the time
      // pagehide fires the animation frame loop is gone, so a queued ptyClose
      // would sit in the wasm outbox forever and leave the shell running on the
      // server.
      globalThis.addEventListener("pagehide", () => {
        if (!ptyID) return
        const closing = ptyID
        ptyID = null
        try {
          void globalThis.__oc?.ptyClose?.({ ptyID: closing })
        } catch (err) {
          console.warn("[opencode-wasm] pty close on pagehide failed", err)
        }
      })

      // No lookup required: find a running server and connect on its own.
      await rescan()
