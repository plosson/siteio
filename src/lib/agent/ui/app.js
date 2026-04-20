// siteio admin UI — single root Alpine component

function siteioAdmin() {
  return {
    // auth
    apiKey: null,
    authed: false,
    loginError: "",

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
      const parts = h.split("/").filter(Boolean) // ["apps"] or ["apps", "myapp"]
      const view = parts[0] || "apps"
      const param = parts[1] || null
      this.route = { view, param, subtab: null }
    },

    navClass(view) {
      return this.route.view === view ? "nav-link nav-link-active" : "nav-link"
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
    },

    async apiFetch(path, options = {}) {
      const res = await fetch(path, {
        ...options,
        headers: { ...(options.headers || {}), "X-API-Key": this.apiKey },
      })
      if (res.status === 401) {
        sessionStorage.removeItem("siteio_api_key")
        window.dispatchEvent(new CustomEvent("siteio:unauthenticated"))
        throw new Error("Unauthenticated")
      }
      return res
    },
  }
}
