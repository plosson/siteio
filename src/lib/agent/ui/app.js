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
    serviceFilter: "all", // all | sites | apps
    selectedSite: null, selectedApp: null,
    siteHistory: null,

    // ui
    toasts: [],
    pending: new Set(),
    hostname: "",

    // logs
    appLogs: "",
    appLogsAuto: true,
    appLogsTimer: null,
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
          if (this.appLogsAuto) this.startLogsPoll()
          else this.loadAppLogs(this.route.param)
        }
      }
      if (this.route.view === "sites" && this.route.param) {
        if (!this.selectedSite || (this.selectedSite !== "not-found" && this.selectedSite.name !== this.route.param)) {
          this.loadSite(this.route.param)
        }
        if (this.route.subtab === "history") this.loadSiteHistory(this.route.param)
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
      this.apiKey = null
      this.authed = false
      this.loginError = "Session expired. Please sign in again."
    },

    onEscape() {
      // If the user is on the logs view, toggle auto-refresh off (quick pause).
      if (this.route.view === "apps" && this.route.subtab === "logs" && this.appLogsAuto) {
        this.appLogsAuto = false
        this.stopLogsPoll()
      }
    },

    // Force Alpine reactivity by reassigning the Set after every mutation.
    _pendAdd(key) { this.pending.add(key); this.pending = new Set(this.pending) },
    _pendDel(key) { this.pending.delete(key); this.pending = new Set(this.pending) },

    logout() {
      this.stopLogsPoll()
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
      } catch (err) {
        if (err && err.message !== "Unauthenticated") {
          this.services = []
          this.toast("error", "Could not reach server")
        }
      } finally {
        this._pendDel("services-list")
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

    formatBytes(n) {
      if (n === undefined || n === null) return "—"
      if (n < 1024) return n + " B"
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB"
      if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB"
      return (n / 1024 / 1024 / 1024).toFixed(1) + " GB"
    },

    async loadAppLogs(name) {
      this._pendAdd("logs")
      try {
        const res = await this.apiFetch(`/apps/${encodeURIComponent(name)}/logs?tail=200`)
        const body = await res.json()
        if (body.success) {
          this.appLogs = body.data.logs || ""
          // Scroll to bottom if auto-refresh is on
          this.$nextTick(() => {
            if (this.appLogsAuto && this.$refs.logsEl) {
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
      this.loadAppLogs(name)
      this.appLogsTimer = setInterval(() => {
        if (document.hidden) return
        this.loadAppLogs(name)
      }, 3000)
      this._logsVisibilityHandler = () => {
        // When page comes back to foreground, fetch immediately
        if (!document.hidden && this.route.subtab === "logs" && this.appLogsAuto) {
          this.loadAppLogs(this.route.param)
        }
      }
      document.addEventListener("visibilitychange", this._logsVisibilityHandler)
    },

    stopLogsPoll() {
      if (this.appLogsTimer) {
        clearInterval(this.appLogsTimer)
        this.appLogsTimer = null
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
