// siteio admin UI — single root Alpine component

function siteioAdmin() {
  return {
    // auth
    apiKey: null,
    authed: false,
    apiKeyInput: "",
    loginError: "",
    loginPending: false,

    // route: view is overview | sites | apps | settings; param is a site/app name
    route: { view: "overview", param: null, subtab: null },

    // data
    services: null, agentInfo: null,
    // Previews: "<kind>:<name>" -> object URL (blob-fetched with the API key).
    thumbs: {},
    filterText: "",
    activityLimit: 10,
    unreachable: false, lastLoadedAt: null,
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
    confirmState: { title: "", body: "", verb: "" },
    _confirmResolve: null,
    pending: new Set(),
    hostname: "",

    // logs (shared by app + site detail)
    logs: "",
    logsAuto: true,
    logsFilter: "",
    logsError: "",
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
      // Other tabs, the CLI or agents change the same data: refresh on return.
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && this.authed && !this.route.param) this.loadServices()
      })
    },

    parseHash() {
      const h = window.location.hash.replace(/^#/, "")
      const parts = h.split("/").filter(Boolean)
      const view = parts[0] || "overview"
      const param = parts[1] || null
      const subtab = parts[2] || null
      // When leaving a logs tab (or any view change), stop any poll
      if (this.route.subtab === "logs" && subtab !== "logs") this.stopLogsPoll()
      if (this.route.subtab === "chat" && subtab !== "chat") this.stopChatPoll()
      // Another object: never show the previous one's logs.
      if (view !== this.route.view || param !== this.route.param) { this.logs = ""; this.logsError = "" }
      this.route = { view, param, subtab }
      if (this.authed) this.onRouteEnter()
    },

    onRouteEnter() {
      // Old links pointed at the merged #/services grid; it became the overview.
      if (this.route.view === "services") {
        window.location.hash = "#/"
        return
      }
      // The header (server name), the nav (apps on/off) and the footer (version)
      // need the agent info on every screen.
      if (this.route.view === "settings" || !this.agentInfo) this.loadAgentInfo()
      if (this.route.view === "overview" || !this.route.param || !this.services) this.loadServices()
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

    // Section shown as current in the header nav (detail pages belong to their list).
    section() {
      return this.route.view
    },

    // Where you are: the server, from the agent, else the host serving this page.
    serverName() {
      return (this.agentInfo && this.agentInfo.domain) || this.hostname
    },

    appsEnabled() {
      return !this.agentInfo || this.agentInfo.appsEnabled !== false
    },

    // The object on the current detail page: null while loading, "not-found", or the data.
    detail() {
      return this.route.view === "sites" ? this.selectedSite : this.selectedApp
    },

    detailTabs() {
      if (this.route.view === "apps") return [{ k: "overview", label: "Overview" }, { k: "logs", label: "Logs" }]
      const tabs = [{ k: "overview", label: "Overview" }, { k: "history", label: "History" }, { k: "logs", label: "Logs" }]
      if (this.selectedSite && this.selectedSite.chatEnabled) tabs.push({ k: "chat", label: "Chat" })
      return tabs
    },

    currentTab() {
      return this.route.subtab || "overview"
    },

    onKey(e) {
      if (e.key === "Escape") return this.onEscape()
      // "/" focuses the filter, unless the person is typing somewhere.
      const typing = e.target && (e.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName))
      if (e.key === "/" && !typing && this.$refs.filterEl) {
        e.preventDefault()
        this.$refs.filterEl.focus()
      }
    },

    async login() {
      this.loginError = ""
      const candidate = this.apiKeyInput.trim()
      if (!candidate) {
        this.loginError = "Enter the API key."
        return
      }
      this.loginPending = true
      try {
        const res = await fetch("/sites", {
          headers: { "X-API-Key": candidate },
        })
        if (res.status === 401) {
          this.loginError = "This API key is not valid. Check it and try again."
          return
        }
        if (!res.ok) {
          this.loginError = `The server answered with an error (${res.status}). Try again in a moment.`
          return
        }
        sessionStorage.setItem("siteio_api_key", candidate)
        this.apiKey = candidate
        this.authed = true
        this.apiKeyInput = ""
        this.onRouteEnter()
      } catch {
        this.loginError = "Can't reach the server. Check your connection and try again."
      } finally {
        this.loginPending = false
      }
    },

    onUnauthenticated() {
      this.stopLogsPoll()
      this.stopChatPoll()
      this.apiKey = null
      this.authed = false
      this.loginError = "Your session ended. Sign in again to continue."
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
          // Keep the previous rows; the banner says the server can't be reached.
          if (this.services === null) this.services = []
          this.unreachable = true
          return
        }
        this.unreachable = false
        this.lastLoadedAt = new Date()
        const merged = [
          ...(sites || []).map((s) => ({ kind: "site", ...s })),
          ...(apps || []).map((a) => ({ kind: "app", ...a })),
        ]
        merged.sort((a, b) => a.name.localeCompare(b.name))
        this.services = merged
        // Load previews in the background — the list renders immediately.
        this.loadThumbnails(merged)
      } catch (err) {
        if (err && err.message !== "Unauthenticated") {
          if (this.services === null) this.services = []
          this.unreachable = true
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
          this.toast("success", "Preview refreshed")
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
        if (!body.success) this.toast("error", body.error || "Can't load the settings")
      } catch (err) {
        if (err && err.message !== "Unauthenticated") this.unreachable = true
      } finally {
        this._pendDel("agent-info")
      }
    },

    // Items of the current section (sites or apps): problems first, then by name.
    collection() {
      if (!this.services) return []
      const kind = this.route.view === "apps" ? "app" : "site"
      const rank = (s) => (this.needsAttention(s) ? 0 : 1)
      return this.services
        .filter((s) => s.kind === kind)
        .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    },

    // Filter by any visible text of the row.
    filteredCollection() {
      const q = this.filterText.trim().toLowerCase()
      if (!q) return this.collection()
      return this.collection().filter((s) =>
        [s.name, this.servicePrimaryDomain(s), this.serviceMeta(s), this.statusText(s)].join(" ").toLowerCase().includes(q))
    },

    // Everything deployed, newest first (the overview's activity list).
    recentDeploys() {
      if (!this.services) return []
      return this.services
        .filter((s) => s.deployedAt)
        .sort((a, b) => new Date(b.deployedAt) - new Date(a.deployedAt))
    },

    needsAttention(item) {
      return item.status === "failed" || item.status === "stopped" || !!item.autoDeployError
    },

    attention() {
      return (this.services || []).filter((s) => this.needsAttention(s))
    },

    attentionLabel(item) {
      if (item.status === "failed") return "failed"
      if (item.status === "stopped") return "is stopped"
      return "can't auto-deploy"
    },

    overviewStatus() {
      if (!this.services) return { text: "⟳ Loading…", cls: "status-neutral" }
      const n = this.services.length
      if (n === 0) return { text: "○ Nothing deployed yet", cls: "status-neutral" }
      const sites = this.services.filter((s) => s.kind === "site").length
      const apps = n - sites
      const parts = [sites + (sites === 1 ? " site" : " sites")]
      if (apps > 0 || this.appsEnabled()) parts.push(apps + (apps === 1 ? " app" : " apps"))
      const down = this.services.filter((s) => s.status === "failed" || s.status === "stopped").length
      if (down === 0) return { text: "✓ All running · " + parts.join(" · "), cls: "status-ok" }
      return { text: "✗ " + down + " of " + n + " stopped or failed", cls: "status-bad" }
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
        const v = item.version ? "v" + item.version : "No version yet"
        return v + " · " + this.formatBytes(item.size)
      }
      return this.appSourceLabel(item)
    },

    // Status as a symbol and a word, never colour alone.
    statusText(item) {
      const kind = item.kind || (this.route.view === "sites" ? "site" : "app")
      switch (item.status) {
        case "running": return kind === "site" ? "✓ Live" : "✓ Running"
        case "stopped": return "✗ Stopped"
        case "failed": return "✗ Failed"
        default: return "⟳ Starting"
      }
    },

    statusClass(item) {
      if (item.status === "running") return "status-ok"
      if (item.status === "stopped" || item.status === "failed") return "status-bad"
      return "status-neutral"
    },

    tlsInfo(tls) {
      if (tls === undefined) {
        const s = (this.services || []).find((x) => x.kind === "site" && x.name === this.route.param)
        tls = s && s.tls
      }
      switch (tls) {
        case "valid": return { text: "✓ On", cls: "status-ok" }
        case "error": return { text: "✗ The certificate could not be issued", cls: "status-bad" }
        case "none": return { text: "○ Off", cls: "status-neutral" }
        case "pending": return { text: "⟳ Waiting for the certificate", cls: "status-neutral" }
        default: return { text: "○ Unknown", cls: "status-neutral" }
      }
    },

    // Deployed in the last hour: marked with the brand dot.
    isRecent(iso) {
      const t = iso ? new Date(iso).getTime() : NaN
      return !isNaN(t) && Date.now() - t < 60 * 60 * 1000
    },

    envKeys() {
      const app = this.selectedApp
      if (!app || app === "not-found") return []
      return [...new Set([...Object.keys(app.env || {}), ...(app.secretKeys || [])])].sort()
    },

    isSecret(key) {
      return !!(this.selectedApp && (this.selectedApp.secretKeys || []).includes(key))
    },

    async copy(text, message) {
      try {
        await navigator.clipboard.writeText(text)
        this.toast("success", message || "Copied")
      } catch {
        this.toast("error", "Can't copy here. Select the text and copy it.")
      }
    },

    // Shared confirmation for destructive actions. Resolves true on confirm.
    askConfirm(title, body, verb) {
      if (this._confirmResolve) this._confirmResolve(false)
      this.confirmState = { title, body, verb }
      const dlg = this.$refs.confirmDlg
      dlg.returnValue = ""
      dlg.showModal()
      return new Promise((resolve) => { this._confirmResolve = resolve })
    },

    onConfirmClose() {
      const resolve = this._confirmResolve
      this._confirmResolve = null
      if (resolve) resolve(this.$refs.confirmDlg.returnValue === "ok")
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
          this.loadThumbnails([{ kind: "app", name: body.data.name, hasThumbnail: true }])
        } else {
          this.selectedApp = "not-found"
          this.toast("error", body.error || "Can't load the app")
        }
      } catch (err) {
        if (err && err.message !== "Unauthenticated") {
          this.selectedApp = "not-found"
          this.unreachable = true
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
          this.toast("error", body.error || "That didn't work. Try again.")
          return
        }
        this.toast("success", successMsg)
      } catch (err) {
        if (err && err.message !== "Unauthenticated") {
          this.toast("error", "Can't reach the server")
        }
      } finally {
        this._pendDel(key)
      }
    },

    async deployApp(name) {
      await this._runAction(name, "deploy", "POST", `/apps/${encodeURIComponent(name)}/deploy`, `Deployed ${name}`)
      await this.loadApp(name)
    },

    async stopApp(name) {
      await this._runAction(name, "stop", "POST", `/apps/${encodeURIComponent(name)}/stop`, `Stopped ${name}`)
      await this.loadApp(name)
    },

    async restartApp(name) {
      await this._runAction(name, "restart", "POST", `/apps/${encodeURIComponent(name)}/restart`, `Restarted ${name}`)
      await this.loadApp(name)
    },

    async removeApp(name) {
      const ok = await this.askConfirm(
        `Remove the app ${name}?`,
        "Its container and image are deleted and its address stops working. This can't be undone.",
        "Remove app",
      )
      if (!ok) return
      await this._runAction(name, "remove", "DELETE", `/apps/${encodeURIComponent(name)}`, `Removed ${name}`)
      this.services = null
      window.location.hash = "#/apps"
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
        if (body.success) this.loadThumbnails([{ kind: "site", ...body.data }])
      } catch (err) {
        if (err && err.message !== "Unauthenticated") {
          this.selectedSite = "not-found"
          this.unreachable = true
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
          this.toast("error", "Can't reach the server")
        }
      }
    },

    async undeploySite(name) {
      const ok = await this.askConfirm(
        `Remove the site ${name}?`,
        "Its files, its data and its history are deleted and its address stops working. This can't be undone.",
        "Remove site",
      )
      if (!ok) return
      this._pendAdd("undeploy")
      try {
        const res = await this.apiFetch(`/sites/${encodeURIComponent(name)}`, { method: "DELETE" })
        const body = await res.json()
        if (!body.success) {
          this.toast("error", body.error || "Can't remove the site")
          return
        }
        this.toast("success", `Removed ${name}`)
        this.services = null
        window.location.hash = "#/sites"
      } catch (err) {
        if (err && err.message !== "Unauthenticated") this.toast("error", "Can't reach the server")
      } finally {
        this._pendDel("undeploy")
      }
    },

    // History tab: restore an older version after confirmation.
    async restoreVersion(name, version) {
      const ok = await this.askConfirm(
        `Restore v${version}?`,
        `The files go back to v${version}. The site's data stays as it is now. The restore is added to the history, so you can undo it.`,
        `Restore v${version}`,
      )
      if (ok) await this.rollbackSite(name, version)
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
          this.toast("error", body.error || "Can't restore this version")
          return
        }
        this.toast("success", `Restored v${version}. It's live now.`)
        await this.loadSite(name)
        await this.loadSiteHistory(name)
      } catch (err) {
        if (err && err.message !== "Unauthenticated") this.toast("error", "Can't reach the server")
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
        if (err && err.message !== "Unauthenticated") this.toast("error", "Can't load the conversation")
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
        // Transport is shared with the in-site editor widget (chat-core.js).
        const result = await window.SiteioChat.streamTurn({
          url: `/sites/${encodeURIComponent(name)}/chat`,
          headers: { "X-API-Key": key },
          body: { message },
          onEvent: (e) => this._applyChatEvent(e, name),
        })
        if (!result.ok) {
          if (result.status === 401) {
            sessionStorage.removeItem("siteio_api_key")
            window.dispatchEvent(new CustomEvent("siteio:unauthenticated"))
            return
          }
          this.toast("error", "The change could not be started. Try again.")
        }
      } catch (err) {
        // Stream dropped — the turn keeps running server-side; resync from history.
        this.toast("error", "Connection lost. Catching up…")
        await this.loadChat(name, true)
      } finally {
        this.chatStreaming = false
        this.chatLiveText = ""; this.chatLiveTools = []; this.chatLiveStatus = ""
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
        this.toast("info", "Stopping… Changes already made stay live until you undo them.")
      } catch (err) {
        if (err && err.message !== "Unauthenticated") this.toast("error", "Can't stop it")
      }
    },

    async clearChat(name) {
      if (this.chatStreaming) return
      const ok = await this.askConfirm(
        "Clear the conversation?",
        "The messages are deleted. Changes already made stay on the site and stay in its history.",
        "Clear history",
      )
      if (!ok) return
      try {
        const res = await this.apiFetch(`/sites/${encodeURIComponent(name)}/chat`, { method: "DELETE" })
        const body = await res.json()
        if (body.success) { this.chatMessages = []; this.toast("success", "Conversation cleared") }
        else this.toast("error", body.error || "Can't clear the conversation")
      } catch (err) {
        if (err && err.message !== "Unauthenticated") this.toast("error", "Can't clear the conversation")
      }
    },

    // Mint a one-time in-site editor link (god key) and open it in a new tab.
    // The shell frames the live site and overlays the chat editor.
    async openLiveEditor(name) {
      this._pendAdd("editlink-" + name)
      try {
        const res = await this.apiFetch(`/sites/${encodeURIComponent(name)}/edit-link`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        })
        const body = await res.json()
        if (body.success && body.data && body.data.url) {
          window.open(body.data.url, "_blank", "noopener")
        } else {
          this.toast("error", (body && body.error) || "Can't open the live editor")
        }
      } catch (err) {
        if (err && err.message !== "Unauthenticated") this.toast("error", "Can't open the live editor")
      } finally {
        this._pendDel("editlink-" + name)
      }
    },

    // Revert a deploying turn by rolling back to the version that preceded it.
    async revertTurn(name, m) {
      if (m.versionBefore === undefined || m.versionBefore === 0) return
      const ok = await this.askConfirm(
        "Undo this change?",
        `The files go back to how they were before v${m.versionAfter}. The site's data stays as it is now.`,
        "Undo change",
      )
      if (!ok) return
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
      if (m.role === "user") return "msg-user"
      if (m.status === "error") return "msg-ai msg-error"
      if (m.status === "no_changes") return "msg-ai msg-quiet"
      return "msg-ai"
    },

    // Compact label for the element/text a message was anchored to (in-site
    // editor picker). Shown under the user bubble so it's clear what was targeted.
    targetLabel(t) {
      if (!t) return ""
      const label = t.selector || t.tag || (t.kind === "text" ? "text" : "element")
      const snippet = t.text ? ' · "' + (t.text.length > 40 ? t.text.slice(0, 40) + "…" : t.text) + '"' : ""
      return label + snippet
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

    // "just now", "2 min ago", "1 h ago" for the last 24 h, then the date in
    // the reader's time zone.
    formatRelativeTime(iso) {
      if (!iso) return ""
      const then = new Date(iso)
      if (isNaN(then.getTime())) return ""
      const secs = Math.max(0, Math.round((Date.now() - then.getTime()) / 1000))
      if (secs < 60) return "just now"
      const mins = Math.floor(secs / 60)
      if (mins < 60) return mins + " min ago"
      const hrs = Math.floor(mins / 60)
      if (hrs < 24) return hrs + " h ago"
      const sameYear = then.getFullYear() === new Date().getFullYear()
      return then.toLocaleDateString(undefined, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" })
    },

    formatClock(d) {
      return d ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : ""
    },

    // Absolute timestamp for tooltips.
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
        // Removed or renamed: the page already says so; stop polling quietly.
        if (res.status === 404) { this.stopLogsPoll(); return }
        const body = await res.json()
        if (body.success) {
          this.logsError = ""
          this.logs = body.data.logs || ""
          // Scroll to bottom if auto-refresh is on
          this.$nextTick(() => {
            if (this.logsAuto && this.$refs.logsEl) {
              this.$refs.logsEl.scrollTop = this.$refs.logsEl.scrollHeight
            }
          })
        } else {
          // Shown in the viewer, not as a toast: polling would repeat it every 3 s.
          this.logsError = body.error || "Unknown error"
        }
      } catch (err) {
        if (err && err.message !== "Unauthenticated") this.logsError = "The server can't be reached."
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

    logLines() {
      if (!this.logs) return []
      const lines = this.logs.split("\n")
      if (lines[lines.length - 1] === "") lines.pop()
      return lines
    },

    // Errors in the error colour; lines matching the filter are highlighted.
    logLineClass(line) {
      const cls = []
      if (/\berror\b/i.test(line)) cls.push("log-error")
      const q = this.logsFilter.trim().toLowerCase()
      if (q && line.toLowerCase().includes(q)) cls.push("log-hit")
      return cls.join(" ")
    },

    // Scrolling up pauses following, so the lines being read don't move.
    onLogsScroll() {
      const el = this.$refs.logsEl
      if (!el || !this.logsAuto) return
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 24) {
        this.logsAuto = false
        this.stopLogsPoll()
      }
    },

    downloadLogs(name) {
      const url = URL.createObjectURL(new Blob([this.logs], { type: "text/plain" }))
      const a = document.createElement("a")
      a.href = url
      a.download = name + ".log"
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    },

    appSourceLabel(app) {
      if (app.compose) return "Compose"
      if (app.git) return "Git · " + app.git.repoUrl.replace(/^https?:\/\//, "")
      if (app.dockerfile) return "Dockerfile"
      return "Image · " + app.image
    },

    toast(type, message) {
      const id = Date.now() + Math.random()
      this.toasts.push({ id, type, message })
      setTimeout(() => { this.toasts = this.toasts.filter(t => t.id !== id) }, 4000)
    },
  }
}
