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
    route: { view: "apps", param: null, subtab: null },

    // data
    sites: null, apps: null, groups: null,
    selectedSite: null, selectedApp: null,

    // ui
    toasts: [],
    pending: new Set(),
    hostname: "",

    init() {
      this.hostname = window.location.hostname
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
      const h = window.location.hash.replace(/^#/, "") || "/apps"
      const parts = h.split("/").filter(Boolean)
      const view = parts[0] || "apps"
      const param = parts[1] || null
      this.route = { view, param, subtab: null }
      if (this.authed) this.onRouteEnter()
    },

    onRouteEnter() {
      if (this.route.view === "apps" && !this.route.param) this.loadApps()
      if (this.route.view === "apps" && this.route.param) this.loadApp(this.route.param)
      // sites + groups wired in later tasks
    },

    navClass(view) {
      return this.route.view === view ? "nav-link nav-link-active" : "nav-link"
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
      this.apiKey = null
      this.authed = false
      this.loginError = "Session expired. Please sign in again."
    },

    logout() {
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

    // --- Apps ---

    async loadApps() {
      this.pending.add("apps-list")
      try {
        const res = await this.apiFetch("/apps")
        const body = await res.json()
        if (body.success) {
          this.apps = body.data
        } else {
          this.apps = []
          this.toast("error", body.error || "Failed to load apps")
        }
      } catch (err) {
        if (err && err.message !== "Unauthenticated") {
          this.apps = []
          this.toast("error", "Could not reach server")
        }
      } finally {
        this.pending.delete("apps-list")
      }
    },

    async loadApp(name) {
      this.selectedApp = null
      this.pending.add("app-detail")
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
        this.pending.delete("app-detail")
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
