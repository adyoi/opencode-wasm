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
        $("model").disabled = !value
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

      const CRED_KEY = "opencode-credentials"

      const basicHeader = (username, password) =>
        `Basic ${btoa(`${username || "opencode"}:${password}`)}`

      /** Credentials remembered from an earlier visit, used when no card is shown. */
      function storedCredentials() {
        try {
          const saved = JSON.parse(localStorage.getItem(CRED_KEY) ?? "null")
          return { username: saved?.username ?? "", password: saved?.password ?? "" }
        } catch {
          return { username: "", password: "" }
        }
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
        if (password) localStorage.setItem(CRED_KEY, JSON.stringify({ username, password }))
        else localStorage.removeItem(CRED_KEY)

        setConnected(false, "menyambung…", "")
        try {
          await call("open", { baseUrl: url, headers })
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
        if (!connected) return
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
              <input id="url" value="${saved.replace(/"/g, "&quot;")}" spellcheck="false" />
              <button id="connect" class="primary">Sambung</button>
              <button id="rescan" title="Cari server opencode di alamat yang biasa">Cari lagi</button>
            </div>
            <div class="row creds">
              <input id="user" placeholder="pengguna (default: opencode)" autocomplete="username" />
              <input id="pass" type="password" placeholder="password server (kalau ada)" autocomplete="current-password" />
            </div>
            <p class="hint" id="connectHint"></p>
          </div>`
        $("connect").onclick = connect
        $("rescan").onclick = () => rescan()
        $("url").onkeydown = (e) => e.key === "Enter" && connect()

        try {
          const saved2 = JSON.parse(localStorage.getItem(CRED_KEY) ?? "null")
          if (saved2) {
            $("user").value = saved2.username ?? ""
            $("pass").value = saved2.password ?? ""
          }
        } catch {}

        // Pages is HTTPS, so a plain ws:// PTY socket is blocked as mixed content.
        const hints = []
        if (note) hints.push(note)
        const servedLocally = ["localhost", "127.0.0.1", ""].includes(location.hostname)
        const savedHost = hostOf(saved)
        const savedIsLoopback = LOOPBACK.includes(savedHost)
        if (!servedLocally && savedIsLoopback) {
          hints.push(
            `Halaman ini dibuka dari <code>${location.hostname}</code>, jadi <code>${savedHost}</code> menunjuk ke komputer ini — bukan ke mesin tempat server berjalan. Buka dari komputer yang sama, atau isi URL server yang bisa dijangkau.`,
          )
        }
        if (!servedLocally && !savedIsLoopback && savedHost) {
          hints.push(
            `<code>${savedHost}</code> hanya menjawab kalau servernya dijalankan dengan <code>--hostname 0.0.0.0</code>. Kalau tidak, pakai <code>127.0.0.1</code> dari komputer yang sama.`,
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

        const hosts = []
        if (location.hostname) hosts.push(location.hostname)
        for (const host of ["127.0.0.1", "localhost"]) if (!hosts.includes(host)) hosts.push(host)
        for (const host of hosts) {
          // keep any port the URL already used, then the common ones
          let port = ""
          try {
            port = query ? new URL(query).port : ""
          } catch {
            /* a malformed ?server= is not worth guessing from */
          }
          if (port && port !== "4096") list.push(`http://${host}:${port}`)
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
            `Server ditemukan di <code>${found.url}</code>, tapi ia memakai password. Isi kolom di bawah lalu tekan <b>Sambung</b>.`,
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

      // No lookup required: find a running server and connect on its own.
      await rescan()
