// siteio admin UI — single root Alpine component

function siteioAdmin() {
  return {
    // auth
    apiKey: null,
    authed: false,
    apiKeyInput: "",
    loginError: "",
    loginPending: false,

    // route
    route: { view: "services", param: null, subtab: null },

    // data
    services: null, agentInfo: null,
    // Card previews: "<kind>:<name>" -> object URL (blob-fetched with the API key).
    thumbs: {},
    serviceFilter: "all", // all | sites | apps
    selectedSite: null, selectedApp: null,
    siteHistory: null,

    // chat (AI editor)
    chatMessages: null, chatStatus: null, chatInput: "",
    chatStreaming: false, chatLiveText: "", chatLiveTools: [], chatLiveStatus: "",
    chatPollTimer: null,
    chatExamples: [
      "Change the main headline to something more welcoming",
      "Make the page use a dark background with light text",
      "Add a footer with a copyright line",
    ],

    // ui
    toasts: [],
    pending: new Set(),
    hostname: "",

    // logs (shared by app + site detail)
    logs: "",
    logsAuto: true,
    logsTimer: null,
    _logsVisibilityHandler: null,

    init() {
      this.hostname = window.location.hostname
      // The `siteio ui` CLI command opens this page with the API key in the
      // query string. Persist it, then strip it from the URL so it doesn't
      // linger in history or get copy-pasted. The hash is left untouched (the
      // router uses it).
      const injectedKey = new URLSearchParams(window.location.search).get("key")
      if (injectedKey) {
        sessionStorage.setItem("siteio_api_key", injectedKey)
        history.replaceState(null, "", window.location.pathname + window.location.hash)
      }
      const key = sessionStorage.getItem("siteio_api_key")
      if (key) {
        this.apiKey = key
        this.authed = true
      }
      this.parseHash()
      window.addEventListener("hashchange", () => this.parseHash())
      window.addEventListener("siteio:unauthenticated", () => this.onUnauthenticated())
    },

    parseHash() {
      const h = window.location.hash.replace(/^#/, "") || "/services"
      const parts = h.split("/").filter(Boolean)
      const view = parts[0] || "services"
      const param = parts[1] || null
      const subtab = parts[2] || null
      // When leaving a logs tab (or any view change), stop any poll
      if (this.route.subtab === "logs" && subtab !== "logs") this.stopLogsPoll()
      if (this.route.subtab === "chat" && subtab !== "chat") this.stopChatPoll()
      this.route = { view, param, subtab }
      if (this.authed) this.onRouteEnter()
    },

    onRouteEnter() {
      // The list views (apps/sites) were merged into one Services grid; redirect
      // any bare #/apps or #/sites (e.g. stale links) to it.
      if ((this.route.view === "apps" || this.route.view === "sites") && !this.route.param) {
        window.location.hash = "#/services"
        return
      }
      if (this.route.view === "services") this.loadServices()
      if (this.route.view === "settings") this.loadAgentInfo()
      if (this.route.view === "apps" && this.route.param) {
        // Only re-fetch the app detail when we arrive on a new app (not on sub-tab change)
        if (!this.selectedApp || (this.selectedApp !== "not-found" && this.selectedApp.name !== this.route.param)) {
          this.loadApp(this.route.param)
        }
        if (this.route.subtab === "logs") {
          if (this.logsAuto) this.startLogsPoll()
          else this.loadLogs(this.route.param)
        }
      }
      if (this.route.view === "sites" && this.route.param) {
        if (!this.selectedSite || (this.selectedSite !== "not-found" && this.selectedSite.name !== this.route.param)) {
          this.loadSite(this.route.param)
        }
        if (this.route.subtab === "history") this.loadSiteHistory(this.route.param)
        if (this.route.subtab === "logs") {
          if (this.logsAuto) this.startLogsPoll()
          else this.loadLogs(this.route.param)
        }
        if (this.route.subtab === "chat") this.loadChat(this.route.param)
      }
    },

    navClass(view) {
      // "Services" stays highlighted on the app/site detail views too.
      const inServices = ["services", "apps", "sites"].includes(this.route.view)
      const active = view === "services" ? inServices : this.route.view === view
      return active ? "nav-link nav-link-active" : "nav-link"
    },

    async login() {
      this.loginError = ""
      const candidate = this.apiKeyInput.trim()
      if (!candidate) {
        this.loginError = "API key is required."
        return
      }
      this.loginPending = true
      try {
        const res = await fetch("/sites", {
          headers: { "X-API-Key": candidate },
        })
        if (res.status === 401) {
          this.loginError = "Invalid API key."
          return
        }
        if (!res.ok) {
          this.loginError = `Server returned ${res.status}.`
          return
        }
        sessionStorage.setItem("siteio_api_key", candidate)
        this.apiKey = candidate
        this.authed = true
        this.apiKeyInput = ""
        this.onRouteEnter()
      } catch {
        this.loginError = "Could not reach server."
      } finally {
        this.loginPending = false
      }
    },

    onUnauthenticated() {
      this.stopLogsPoll()
      this.stopChatPoll()
      this.apiKey = null
      this.authed = false
      this.loginError = "Session expired. Please sign in again."
    },

    onEscape() {
      // If the user is on a logs view (app or site), toggle auto-refresh off.
      if ((this.route.view === "apps" || this.route.view === "sites") && this.route.subtab === "logs" && this.logsAuto) {
        this.logsAuto = false
        this.stopLogsPoll()
      }
    },

    // Force Alpine reactivity by reassigning the Set after every mutation.
    _pendAdd(key) { this.pending.add(key); this.pending = new Set(this.pending) },
    _pendDel(key) { this.pending.delete(key); this.pending = new Set(this.pending) },

    logout() {
      this.stopLogsPoll()
      this.stopChatPoll()
      sessionStorage.removeItem("siteio_api_key")
      this.apiKey = null
      this.authed = false
      this.loginError = ""
      this.apiKeyInput = ""
    },

    async apiFetch(path, options = {}) {
      const key = sessionStorage.getItem("siteio_api_key")
      const res = await fetch(path, {
        ...options,
        headers: { ...(options.headers || {}), "X-API-Key": key },
      })
      if (res.status === 401) {
        sessionStorage.removeItem("siteio_api_key")
        window.dispatchEvent(new CustomEvent("siteio:unauthenticated"))
        throw new Error("Unauthenticated")
      }
      return res
    },

    // --- Services (unified sites + apps) ---

    // Fetch a list endpoint, returning [] on any non-auth failure (e.g. /apps
    // returns 403 when the apps surface is disabled). Auth errors re-throw so
    // the shared 401 handler can redirect to login.
    async _fetchList(path) {
      try {
        const res = await this.apiFetch(path)
        if (!res.ok) return []
        const body = await res.json()
        return body.success && Array.isArray(body.data) ? body.data : []
      } catch (err) {
        if (err && err.message === "Unauthenticated") throw err
        return null
      }
    },

    async loadServices() {
      this._pendAdd("services-list")
      try {
        const [sites, apps] = await Promise.all([
          this._fetchList("/sites"),
          this._fetchList("/apps"),
        ])
        if (sites === null && apps === null) {
          this.services = []
          this.toast("error", "Could not reach server")
          return
        }
        const merged = [
          ...(sites || []).map((s) => ({ kind: "site", ...s })),
          ...(apps || []).map((a) => ({ kind: "app", ...a })),
        ]
        merged.sort((a, b) => a.name.localeCompare(b.name))
        this.services = merged
        // Load previews in the background — the grid renders immediately.
        this.loadThumbnails(merged)
      } catch (err) {
        if (err && err.message !== "Unauthenticated") {
          this.services = []
          this.toast("error", "Could not reach server")
        }
      } finally {
        this._pendDel("services-list")
      }
    },

    // The thumbnail endpoint for a card (sites and apps both expose one).
    thumbEndpoint(item) {
      return "/" + (item.kind === "site" ? "sites" : "apps") + "/" + item.name + "/thumbnail"
    },

    // Blob-fetch each preview with the API key (a bare <img src> can't send the
    // auth header) and expose it as an object URL. Best-effort per item; a miss
    // just leaves the placeholder.
    async loadThumbnails(items) {
      for (const item of items) {
        if (!item.hasThumbnail) continue
        const key = item.kind + ":" + item.name
        if (this.thumbs[key]) continue
        try {
          const res = await this.apiFetch(this.thumbEndpoint(item))
          if (!res.ok) continue
          const url = URL.createObjectURL(await res.blob())
          this.thumbs = { ...this.thumbs, [key]: url }
        } catch (err) {
          if (err && err.message === "Unauthenticated") return
        }
      }
    },

    // Regenerate a card's preview, then swap in the fresh image.
    async refreshThumbnail(item) {
      const key = item.kind + ":" + item.name
      const pk = "thumb:" + key
      if (this.pending.has(pk)) return
      this._pendAdd(pk)
      try {
        const res = await this.apiFetch(this.thumbEndpoint(item), { method: "POST" })
        if (!res.ok) {
          let reason = "Could not refresh preview"
          try { const b = await res.json(); if (b && b.error) reason = b.error } catch (_) {}
          this.toast("error", reason)
          return
        }
        const img = await this.apiFetch(this.thumbEndpoint(item))
        if (img.ok) {
          const old = this.thumbs[key]
          this.thumbs = { ...this.thumbs, [key]: URL.createObjectURL(await img.blob()) }
          if (old) URL.revokeObjectURL(old)
          this.toast("success", "Preview updated")
        }
      } catch (err) {
        if (!err || err.message !== "Unauthenticated") this.toast("error", "Could not refresh preview")
      } finally {
        this._pendDel(pk)
      }
    },

    async loadAgentInfo() {
      this._pendAdd("agent-info")
      try {
        const res = await this.apiFetch("/agent")
        const body = await res.json()
        this.agentInfo = body.success ? body.data : null
        if (!body.success) this.toast("error", body.error || "Failed to load settings")
      } catch (err) {
        if (err && err.message !== "Unauthenticated") this.toast("error", "Could not reach server")
      } finally {
        this._pendDel("agent-info")
      }
    },

    filteredServices() {
      if (!this.services) return null
      if (this.serviceFilter === "sites") return this.services.filter((s) => s.kind === "site")
      if (this.serviceFilter === "apps") return this.services.filter((s) => s.kind === "app")
      return this.services
    },

    serviceCount(filter) {
      if (!this.services) return 0
      if (filter === "all") return this.services.length
      const kind = filter === "sites" ? "site" : "app"
      return this.services.filter((s) => s.kind === kind).length
    },

    // Primary domain shown on a card: a custom domain if set, else the default
    // <name>.<agent-domain> host derived from the service url.
    servicePrimaryDomain(item) {
      if (item.domains && item.domains.length > 0) return item.domains[0]
      if (item.url) return item.url.replace(/^https?:\/\//, "").replace(/\/$/, "")
      return item.name
    },

    serviceHref(item) {
      return "#/" + (item.kind === "site" ? "sites" : "apps") + "/" + item.name
    },

    serviceMeta(item) {
      if (item.kind === "site") {
        const v = item.version ? "v" + item.version : "—"
        return v + " · " + this.formatBytes(item.size)
      }
      return this.appSourceLabel(item)
    },

    async loadApp(name) {
      this.selectedApp = null
      this._pendAdd("app-detail")
      try {
        const res = await this.apiFetch("/apps/" + encodeURIComponent(name))
        if (res.status === 404) {
          this.selectedApp = "not-found"
          return
        }
        const body = await res.json()
        if (body.success) {
          this.selectedApp = body.data
        } else {
          this.selectedApp = "not-found"
          this.toast("error", body.error || "Failed to load app")
        }
      } catch (err) {
        if (err && err.message !== "Unauthenticated") {
          this.selectedApp = "not-found"
          this.toast("error", "Could not reach server")
        }
      } finally {
        this._pendDel("app-detail")
      }
    },

    async _runAction(name, key, method, path, successMsg) {
      this._pendAdd(key)
      try {
        const res = await this.apiFetch(path, { method })
        const body = await res.json()
        if (!body.success) {
          this.toast("error", body.error || "Action failed")
          return
        }
        this.toast("success", successMsg)
      } catch (err) {
        if (err && err.message !== "Unauthenticated") {
          this.toast("error", "Could not reach server")
        }
      } finally {
        this._pendDel(key)
      }
    },

    async deployApp(name) {
      await this._runAction(name, "deploy", "POST", `/apps/${encodeURIComponent(name)}/deploy`, `App ${name} deployed`)
      await this.loadApp(name)
    },

    async stopApp(name) {
      await this._runAction(name, "stop", "POST", `/apps/${encodeURIComponent(name)}/stop`, `App ${name} stopped`)
      await this.loadApp(name)
    },

    async restartApp(name) {
      await this._runAction(name, "restart", "POST", `/apps/${encodeURIComponent(name)}/restart`, `App ${name} restarted`)
      await this.loadApp(name)
    },

    async removeApp(name) {
      if (!confirm(`Remove app '${name}'? Container and image will be deleted.`)) return
      await this._runAction(name, "remove", "DELETE", `/apps/${encodeURIComponent(name)}`, `App ${name} removed`)
      // After removal, navigate back to the list
      window.location.hash = "#/services"
    },

    anyAppActionPending() {
      return this.pending.has("deploy")
          || this.pending.has("stop")
          || this.pending.has("restart")
          || this.pending.has("remove")
    },

    // --- Sites ---

    async loadSite(name) {
      this.selectedSite = null
      try {
        const res = await this.apiFetch(`/sites/${encodeURIComponent(name)}`)
        if (res.status === 404) { this.selectedSite = "not-found"; return }
        const body = await res.json()
        this.selectedSite = body.success ? body.data : "not-found"
      } catch (err) {
        if (err && err.message !== "Unauthenticated") {
          this.selectedSite = "not-found"
          this.toast("error", "Could not reach server")
        }
      }
    },

    async loadSiteHistory(name) {
      this.siteHistory = null
      try {
        const res = await this.apiFetch(`/sites/${encodeURIComponent(name)}/history`)
        if (res.status === 404) { this.siteHistory = []; return }
        const body = await res.json()
        this.siteHistory = body.success ? body.data : []
      } catch (err) {
        if (err && err.message !== "Unauthenticated") {
          this.siteHistory = []
          this.toast("error", "Could not reach server")
        }
      }
    },

    async undeploySite(name) {
      if (!confirm(`Remove site '${name}'? Its files AND data will be deleted.`)) return
      this._pendAdd("undeploy")
      try {
        const res = await this.apiFetch(`/sites/${encodeURIComponent(name)}`, { method: "DELETE" })
        const body = await res.json()
        if (!body.success) {
          this.toast("error", body.error || "Failed to undeploy")
          return
        }
        this.toast("success", `Site ${name} removed`)
        window.location.hash = "#/services"
      } catch (err) {
        if (err && err.message !== "Unauthenticated") this.toast("error", "Could not reach server")
      } finally {
        this._pendDel("undeploy")
      }
    },

    async rollbackSite(name, version) {
      this._pendAdd("rollback-" + version)
      try {
        const res = await this.apiFetch(`/sites/${encodeURIComponent(name)}/rollback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version }),
        })
        const body = await res.json()
        if (!body.success) {
          this.toast("error", body.error || "Rollback failed")
          return
        }
        this.toast("success", `Rolled back to v${version}`)
        await this.loadSite(name)
        await this.loadSiteHistory(name)
      } catch (err) {
        if (err && err.message !== "Unauthenticated") this.toast("error", "Could not reach server")
      } finally {
        this._pendDel("rollback-" + version)
      }
    },

    // --- Chat (AI editor) ---

    // Load transcript + status. `quiet` avoids the loading flicker during
    // in-place refreshes (after a turn, or while polling another client's turn).
    async loadChat(name, quiet = false) {
      if (!quiet) { this.chatMessages = null; this.chatStatus = null }
      try {
        const res = await this.apiFetch(`/sites/${encodeURIComponent(name)}/chat`)
        if (res.status === 404) { this.chatMessages = []; return }
        const body = await res.json()
        if (body.success) {
          this.chatMessages = body.data.messages || []
          this.chatStatus = body.data.status || null
          // Resync a turn started elsewhere (or before a reload) via polling.
          if (this.chatStatus && this.chatStatus.active && !this.chatStreaming && !this.chatPollTimer) {
            this.startChatPoll(name)
          }
        }
      } catch (err) {
        if (err && err.message !== "Unauthenticated") this.toast("error", "Could not load chat")
      }
      this._chatScrollBottom()
    },

    async sendChat(name) {
      const message = this.chatInput.trim()
      if (!message || this.chatStreaming) return
      this.chatInput = ""
      // Optimistic user bubble; the authoritative transcript is reloaded on done.
      this.chatMessages = [...(this.chatMessages || []), {
        id: "tmp-" + Date.now(), role: "user", text: message, at: new Date().toISOString(),
      }]
      this.chatStreaming = true
      this.chatLiveText = ""; this.chatLiveTools = []; this.chatLiveStatus = ""
      this._chatScrollBottom()
      try {
        const key = sessionStorage.getItem("siteio_api_key")
        const res = await fetch(`/sites/${encodeURIComponent(name)}/chat`, {
          method: "POST",
          headers: { "X-API-Key": key, "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        })
        if (res.status === 401) {
          sessionStorage.removeItem("siteio_api_key")
          window.dispatchEvent(new CustomEvent("siteio:unauthenticated"))
          return
        }
        if (!res.ok || !res.body) { this.toast("error", "Chat request failed"); return }
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ""
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let idx
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            this._handleChatFrame(buf.slice(0, idx), name)
            buf = buf.slice(idx + 2)
          }
        }
      } catch (err) {
        // Stream dropped — the turn keeps running server-side; resync from history.
        this.toast("error", "Connection lost — resyncing…")
        await this.loadChat(name, true)
      } finally {
        this.chatStreaming = false
        this.chatLiveText = ""; this.chatLiveTools = []; this.chatLiveStatus = ""
      }
    },

    _handleChatFrame(frame, name) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue // ignore ": ping" heartbeats
        const json = line.slice(5).trim()
        if (!json) continue
        let e
        try { e = JSON.parse(json) } catch { continue }
        this._applyChatEvent(e, name)
      }
    },

    _applyChatEvent(e, name) {
      if (e.kind === "assistant_text") this.chatLiveText += e.text
      else if (e.kind === "tool_call") this.chatLiveTools = [...this.chatLiveTools, { name: e.name, detail: e.detail }]
      else if (e.kind === "deploy_progress") this.chatLiveStatus = e.message
      else if (e.kind === "done") {
        this.chatStreaming = false
        // Reconcile optimistic bubble with the authoritative transcript.
        this.loadChat(name, true)
        if (e.message && e.message.deployed) this.loadSite(name)
      } else if (e.kind === "error") {
        this.chatStreaming = false
        this.toast("error", e.message)
        this.loadChat(name, true)
      }
      this._chatScrollBottom()
    },

    async stopChat(name) {
      try {
        await this.apiFetch(`/sites/${encodeURIComponent(name)}/chat/stop`, { method: "POST" })
        this.toast("info", "Stopping…")
      } catch (err) {
        if (err && err.message !== "Unauthenticated") this.toast("error", "Could not stop")
      }
    },

    async clearChat(name) {
      if (this.chatStreaming) return
      if (!confirm("Clear this site's chat history?")) return
      try {
        const res = await this.apiFetch(`/sites/${encodeURIComponent(name)}/chat`, { method: "DELETE" })
        const body = await res.json()
        if (body.success) { this.chatMessages = []; this.toast("success", "History cleared") }
        else this.toast("error", body.error || "Could not clear history")
      } catch (err) {
        if (err && err.message !== "Unauthenticated") this.toast("error", "Could not clear history")
      }
    },

    // Revert a deploying turn by rolling back to the version that preceded it.
    async revertTurn(name, m) {
      if (m.versionBefore === undefined || m.versionBefore === 0) return
      if (!confirm(`Revert this change? The site rolls back to the state before v${m.versionAfter}.`)) return
      this._pendAdd("revert-" + m.id)
      try {
        await this.rollbackSite(name, m.versionBefore)
        await this.loadChat(name, true)
      } finally {
        this._pendDel("revert-" + m.id)
      }
    },

    startChatPoll(name) {
      this.stopChatPoll()
      // Chat work must not pause when the tab is hidden (unlike logs). Stop once
      // the server reports no active turn (result is now in the transcript).
      this.chatPollTimer = setInterval(async () => {
        await this.loadChat(name, true)
        if (this.chatStreaming || !this.chatStatus || !this.chatStatus.active) this.stopChatPoll()
      }, 3000)
    },

    stopChatPoll() {
      if (this.chatPollTimer) { clearInterval(this.chatPollTimer); this.chatPollTimer = null }
    },

    chatBubbleClass(m) {
      if (m.role === "user") return "bg-brand-blue text-white border-brand-blue"
      if (m.status === "error") return "bg-red-50 border-red-200 text-red-800"
      if (m.status === "no_changes") return "bg-white border-gray-200 text-gray-500"
      return "bg-white border-gray-200 text-gray-800"
    },

    _chatScrollBottom() {
      this.$nextTick(() => {
        const el = this.$refs.chatScroll
        if (el) el.scrollTop = el.scrollHeight
      })
    },

    formatBytes(n) {
      if (n === undefined || n === null) return "—"
      if (n < 1024) return n + " B"
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB"
      if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB"
      return (n / 1024 / 1024 / 1024).toFixed(1) + " GB"
    },

    // Compact "time ago" for card timestamps (e.g. "3d ago", "just now").
    formatRelativeTime(iso) {
      if (!iso) return ""
      const then = new Date(iso).getTime()
      if (isNaN(then)) return ""
      const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
      if (secs < 60) return "just now"
      const mins = Math.round(secs / 60)
      if (mins < 60) return mins + "m ago"
      const hrs = Math.round(mins / 60)
      if (hrs < 24) return hrs + "h ago"
      const days = Math.round(hrs / 24)
      if (days < 30) return days + "d ago"
      const months = Math.round(days / 30)
      if (months < 12) return months + "mo ago"
      return Math.round(months / 12) + "y ago"
    },

    // Last deployment time of the service (not the thumbnail). Empty if never
    // deployed (e.g. a site whose first deploy is still pending).
    serviceUpdated(item) {
      return item && item.deployedAt ? "Updated " + this.formatRelativeTime(item.deployedAt) : ""
    },

    // Absolute timestamp for the card tooltip.
    formatAbsoluteTime(iso) {
      if (!iso) return ""
      const d = new Date(iso)
      return isNaN(d.getTime()) ? "" : d.toLocaleString()
    },

    // Apps and sites both expose /<kind>/:name/logs; the logs UI is shared and
    // targets whichever detail view is active.
    logsBasePath() {
      return this.route.view === "sites" ? "/sites" : "/apps"
    },

    async loadLogs(name) {
      this._pendAdd("logs")
      try {
        const res = await this.apiFetch(`${this.logsBasePath()}/${encodeURIComponent(name)}/logs?tail=200`)
        const body = await res.json()
        if (body.success) {
          this.logs = body.data.logs || ""
          // Scroll to bottom if auto-refresh is on
          this.$nextTick(() => {
            if (this.logsAuto && this.$refs.logsEl) {
              this.$refs.logsEl.scrollTop = this.$refs.logsEl.scrollHeight
            }
          })
        } else {
          this.toast("error", body.error || "Failed to load logs")
        }
      } catch (err) {
        if (err && err.message !== "Unauthenticated") {
          this.toast("error", "Could not reach server")
        }
      } finally {
        this._pendDel("logs")
      }
    },

    startLogsPoll() {
      this.stopLogsPoll()
      const name = this.route.param
      if (!name) return
      this.loadLogs(name)
      this.logsTimer = setInterval(() => {
        if (document.hidden) return
        this.loadLogs(name)
      }, 3000)
      this._logsVisibilityHandler = () => {
        // When page comes back to foreground, fetch immediately
        if (!document.hidden && this.route.subtab === "logs" && this.logsAuto) {
          this.loadLogs(this.route.param)
        }
      }
      document.addEventListener("visibilitychange", this._logsVisibilityHandler)
    },

    stopLogsPoll() {
      if (this.logsTimer) {
        clearInterval(this.logsTimer)
        this.logsTimer = null
      }
      if (this._logsVisibilityHandler) {
        document.removeEventListener("visibilitychange", this._logsVisibilityHandler)
        this._logsVisibilityHandler = null
      }
    },

    appSourceLabel(app) {
      if (app.compose) return "compose"
      if (app.git) return "git"
      if (app.dockerfile) return "dockerfile"
      return "image"
    },

    statusBadgeClass(status) {
      switch (status) {
        case "running": return "bg-green-100 text-green-800"
        case "stopped": return "bg-gray-100 text-gray-700"
        case "failed":  return "bg-red-100 text-red-800"
        case "pending":
        default:        return "bg-amber-100 text-amber-800"
      }
    },

    toast(type, message) {
      const id = Date.now() + Math.random()
      this.toasts.push({ id, type, message })
      setTimeout(() => { this.toasts = this.toasts.filter(t => t.id !== id) }, 4000)
    },
  }
}
