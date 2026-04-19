import type { AgentConfig, AgentOAuthConfig, ApiResponse, SiteInfo, SiteMetadata, SiteOAuth, Group, App, AppInfo, ContainerLogs } from "../../types.ts"
import { SiteStorage } from "./storage.ts"
import { TraefikManager } from "./traefik.ts"
import { loadOAuthConfig, ensureDiscoveredConfig } from "../../config/oauth.ts"
import { GroupStorage } from "./groups.ts"
import { AppStorage } from "./app-storage.ts"
import { DockerManager } from "./docker.ts"
import type { Runtime } from "./runtime.ts"
import { GitManager } from "./git.ts"
import { DockerfileStorage } from "./dockerfile-storage.ts"
import { ComposeStorage } from "./compose-storage.ts"
import { buildOverride } from "./compose-override.ts"
import { PersistentStorageManager } from "./persistent-storage.ts"
import { STORAGE_SHIM_JS } from "./storage-shim.ts"

export class AgentServer {
  private config: AgentConfig
  private storage: SiteStorage
  private groups: GroupStorage
  private appStorage: AppStorage
  private docker: Runtime
  private git: GitManager
  private dockerfiles: DockerfileStorage
  private compose: ComposeStorage
  private persistentStorage: PersistentStorageManager
  private traefik: TraefikManager | null = null
  private server: ReturnType<typeof Bun.serve> | null = null
  private oauthConfig: AgentOAuthConfig | null = null

  constructor(config: AgentConfig, runtime?: Runtime) {
    this.config = config
    this.storage = new SiteStorage(config.dataDir)
    this.groups = new GroupStorage(config.dataDir)
    this.appStorage = new AppStorage(config.dataDir)
    this.docker = runtime ?? new DockerManager(config.dataDir)
    this.git = new GitManager(config.dataDir)
    this.dockerfiles = new DockerfileStorage(config.dataDir)
    this.compose = new ComposeStorage(config.dataDir)
    this.persistentStorage = new PersistentStorageManager(config.dataDir)

    // Load OAuth config if it exists
    this.oauthConfig = loadOAuthConfig(config.dataDir)

    if (!config.skipTraefik) {
      this.traefik = new TraefikManager({
        dataDir: config.dataDir,
        domain: config.domain,
        email: config.email,
        httpPort: config.httpPort,
        httpsPort: config.httpsPort,
        fileServerPort: config.port || 3000,
        acme: config.acme,
        oauthConfig: this.oauthConfig || undefined,
      })
    }
  }

  hasOAuthEnabled(): boolean {
    return this.oauthConfig !== null
  }

  private updateRoutingConfig(sites: SiteMetadata[]): void {
    if (this.traefik) {
      this.traefik.updateDynamicConfig(sites)
      this.traefik.updateNginxConfig(sites)
      this.traefik.reloadNginx()
    }
  }

  private json<T>(data: T, status = 200): Response {
    return Response.json({ success: true, data } as ApiResponse<T>, { status })
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
  }

  private error(message: string, status = 400): Response {
    return Response.json({ success: false, error: message } as ApiResponse<null>, { status })
  }

  private checkAuth(req: Request): boolean {
    const apiKey = req.headers.get("X-API-Key")
    return apiKey === this.config.apiKey
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    const host = req.headers.get("host") || ""
    const hostWithoutPort = host.split(":")[0] || ""

    // Auth check for Traefik forwardAuth (no auth required - called by Traefik)
    // This must be checked BEFORE the API/static routing because Traefik
    // forwards the original Host header of the request being authorized
    if (path === "/auth/check" && req.method === "GET") {
      return this.handleAuthCheck(req)
    }

    // Persistent storage API (proxied from nginx for site subdomains, or direct in test mode)
    if (path === "/__storage/shim.js" && req.method === "GET") {
      return this.handleStorageShim()
    }
    if (path === "/__storage/" || path === "/__storage") {
      if (req.method === "GET") {
        return this.handleStorageGet(hostWithoutPort, req)
      }
      if (req.method === "PUT") {
        return this.handleStoragePut(hostWithoutPort, req)
      }
    }

    // Check if this is an API request (api.domain)
    const isApiRequest = hostWithoutPort === `api.${this.config.domain}` ||
      hostWithoutPort === "localhost" ||
      hostWithoutPort === "127.0.0.1"

    if (!isApiRequest) {
      // Non-API requests are handled by nginx containers via Traefik
      // In test mode (skipTraefik), return 404
      return this.error("Not found - requests should go through Traefik", 404)
    }

    // API routes - require authentication (except health)

    // Health check (no auth required)
    if (path === "/health" && req.method === "GET") {
      return this.json({ status: "ok" })
    }

    // OAuth status (no auth required - public info)
    if (path === "/oauth/status" && req.method === "GET") {
      return this.json({ enabled: this.hasOAuthEnabled() })
    }

    // All other routes require auth
    if (!this.checkAuth(req)) {
      return this.error("Unauthorized", 401)
    }

    // GET /sites - list all sites
    if (path === "/sites" && req.method === "GET") {
      return await this.handleListSites()
    }

    // POST /sites/:subdomain - deploy a site
    const deployMatch = path.match(/^\/sites\/([a-z0-9-]+)$/)
    if (deployMatch && req.method === "POST") {
      return this.handleDeploy(deployMatch[1]!, req)
    }

    // DELETE /sites/:subdomain - undeploy a site
    if (deployMatch && req.method === "DELETE") {
      return this.handleUndeploy(deployMatch[1]!)
    }

    // GET /sites/:subdomain/download - download site as zip
    const downloadMatch = path.match(/^\/sites\/([a-z0-9-]+)\/download$/)
    if (downloadMatch && req.method === "GET") {
      return this.handleDownload(downloadMatch[1]!)
    }

    // PATCH /sites/:subdomain/auth - update site authentication
    const authMatch = path.match(/^\/sites\/([a-z0-9-]+)\/auth$/)
    if (authMatch && req.method === "PATCH") {
      return this.handleUpdateAuth(authMatch[1]!, req)
    }

    // PATCH /sites/:subdomain/domains - update site custom domains
    const domainsMatch = path.match(/^\/sites\/([a-z0-9-]+)\/domains$/)
    if (domainsMatch && req.method === "PATCH") {
      return this.handleUpdateDomains(domainsMatch[1]!, req)
    }

    // GET /sites/:subdomain/history - get site version history
    const historyMatch = path.match(/^\/sites\/([a-z0-9-]+)\/history$/)
    if (historyMatch && req.method === "GET") {
      return this.handleGetHistory(historyMatch[1]!)
    }

    // POST /sites/:subdomain/rollback - rollback to a previous version
    const rollbackMatch = path.match(/^\/sites\/([a-z0-9-]+)\/rollback$/)
    if (rollbackMatch && req.method === "POST") {
      return this.handleRollback(rollbackMatch[1]!, req)
    }

    // PATCH /sites/:subdomain/rename - rename a site
    const renameMatch = path.match(/^\/sites\/([a-z0-9-]+)\/rename$/)
    if (renameMatch && req.method === "PATCH") {
      return this.handleRename(renameMatch[1]!, req)
    }

    // PATCH /sites/:subdomain/storage - toggle persistent storage
    const storageToggleMatch = path.match(/^\/sites\/([a-z0-9-]+)\/storage$/)
    if (storageToggleMatch && req.method === "PATCH") {
      return this.handleToggleStorage(storageToggleMatch[1]!, req)
    }

    // GET /groups - list all groups
    if (path === "/groups" && req.method === "GET") {
      return this.handleListGroups()
    }

    // POST /groups - create a group
    if (path === "/groups" && req.method === "POST") {
      return this.handleCreateGroup(req)
    }

    // GET /groups/:name - get a group
    const groupMatch = path.match(/^\/groups\/([a-z0-9-]+)$/)
    if (groupMatch && req.method === "GET") {
      return this.handleGetGroup(groupMatch[1]!)
    }

    // PUT /groups/:name - update a group
    if (groupMatch && req.method === "PUT") {
      return this.handleUpdateGroup(groupMatch[1]!, req)
    }

    // DELETE /groups/:name - delete a group
    if (groupMatch && req.method === "DELETE") {
      return this.handleDeleteGroup(groupMatch[1]!)
    }

    // PATCH /groups/:name/emails - add/remove emails from a group
    const groupEmailsMatch = path.match(/^\/groups\/([a-z0-9-]+)\/emails$/)
    if (groupEmailsMatch && req.method === "PATCH") {
      return this.handleModifyGroupEmails(groupEmailsMatch[1]!, req)
    }

    // GET /apps - list all apps
    if (path === "/apps" && req.method === "GET") {
      return await this.handleListApps()
    }

    // POST /apps - create app
    if (path === "/apps" && req.method === "POST") {
      return this.handleCreateApp(req)
    }

    // App routes with name parameter
    const appMatch = path.match(/^\/apps\/([a-z0-9-]+)$/)
    if (appMatch) {
      const appName = appMatch[1]!
      // GET /apps/:name - get app details
      if (req.method === "GET") {
        return this.handleGetApp(appName)
      }
      // PATCH /apps/:name - update app
      if (req.method === "PATCH") {
        return this.handleUpdateApp(appName, req)
      }
      // DELETE /apps/:name - delete app
      if (req.method === "DELETE") {
        return this.handleDeleteApp(appName)
      }
    }

    // POST /apps/:name/deploy - deploy app
    const appDeployMatch = path.match(/^\/apps\/([a-z0-9-]+)\/deploy$/)
    if (appDeployMatch && req.method === "POST") {
      return this.handleDeployApp(appDeployMatch[1]!, url, req)
    }

    // POST /apps/:name/stop - stop app
    const appStopMatch = path.match(/^\/apps\/([a-z0-9-]+)\/stop$/)
    if (appStopMatch && req.method === "POST") {
      return this.handleStopApp(appStopMatch[1]!)
    }

    // POST /apps/:name/restart - restart app
    const appRestartMatch = path.match(/^\/apps\/([a-z0-9-]+)\/restart$/)
    if (appRestartMatch && req.method === "POST") {
      return this.handleRestartApp(appRestartMatch[1]!)
    }

    // GET /apps/:name/logs - get app logs
    const appLogsMatch = path.match(/^\/apps\/([a-z0-9-]+)\/logs$/)
    if (appLogsMatch && req.method === "GET") {
      return this.handleGetAppLogs(appLogsMatch[1]!, url)
    }

    return this.error("Not found", 404)
  }

  private async handleListSites(): Promise<Response> {
    const sites = this.storage.listSites()

    // Get TLS status from Traefik if available
    const tlsStatusMap = this.traefik ? await this.traefik.getAllRoutersTlsStatus() : new Map()

    const siteInfos: SiteInfo[] = sites.map((site) => ({
      subdomain: site.subdomain,
      url: `https://${site.subdomain}.${this.config.domain}`,
      domains: site.domains,
      size: site.size,
      version: site.version,
      deployedAt: site.deployedAt,
      oauth: site.oauth,
      persistentStorage: site.persistentStorage,
      tls: tlsStatusMap.get(`site-${site.subdomain}`) || "pending",
    }))
    return this.json(siteInfos)
  }

  private async handleDeploy(subdomain: string, req: Request): Promise<Response> {
    // Validate subdomain
    if (!/^[a-z0-9-]+$/.test(subdomain)) {
      return this.error("Invalid subdomain. Use lowercase letters, numbers, and hyphens only.")
    }

    // Check reserved subdomains
    if (subdomain === "api") {
      return this.error("'api' is a reserved subdomain.")
    }

    // Check content type
    const contentType = req.headers.get("Content-Type")
    if (contentType !== "application/zip") {
      return this.error("Content-Type must be application/zip")
    }

    // Check content length
    const contentLength = parseInt(req.headers.get("Content-Length") || "0", 10)
    if (contentLength > this.config.maxUploadSize) {
      return this.error(`Upload size exceeds limit of ${this.config.maxUploadSize} bytes`)
    }

    try {
      // Check for version conflict (optimistic concurrency control)
      const expectedVersionHeader = req.headers.get("X-Expected-Version")
      if (expectedVersionHeader !== null) {
        const expectedVersion = parseInt(expectedVersionHeader, 10)
        if (!isNaN(expectedVersion)) {
          const existingMetadata = this.storage.getMetadata(subdomain)
          if (existingMetadata?.version !== undefined && existingMetadata.version !== expectedVersion) {
            return this.error(
              `Version conflict: expected v${expectedVersion} but server has v${existingMetadata.version}. Someone else deployed since your last push. Use --force to override.`,
              409
            )
          }
        }
      }

      // Read the zip data
      const zipData = new Uint8Array(await req.arrayBuffer())

      // Check for deployer identity
      const deployedBy = req.headers.get("X-Deployed-By") || undefined

      // Check for OAuth headers
      const allowedEmails = req.headers.get("X-Site-OAuth-Emails")
      const allowedDomain = req.headers.get("X-Site-OAuth-Domain")

      let oauth: SiteOAuth | undefined
      if (allowedEmails || allowedDomain) {
        // Reject if OAuth is not configured
        if (!this.hasOAuthEnabled()) {
          return this.error(
            "Google authentication not configured. Run 'siteio agent oauth' on the server to enable it.",
            400
          )
        }

        oauth = {}
        if (allowedEmails) {
          oauth.allowedEmails = allowedEmails.split(",").map((e) => e.trim().toLowerCase())
        }
        if (allowedDomain) {
          oauth.allowedDomain = allowedDomain.toLowerCase()
        }
      }

      // Extract and store site files
      const metadata = await this.storage.extractAndStore(subdomain, zipData, oauth, deployedBy)

      // Handle persistent storage header
      const persistentStorageHeader = req.headers.get("X-Site-Persistent-Storage")
      if (persistentStorageHeader === "true") {
        this.storage.updatePersistentStorage(subdomain, true)
        metadata.persistentStorage = true
      }

      // Update routing config (Traefik dynamic config + nginx) for this site
      // Static sites are served by the shared nginx container
      const allSites = this.storage.listSites()
      this.updateRoutingConfig(allSites)

      const siteInfo: SiteInfo = {
        subdomain: metadata.subdomain,
        url: `https://${metadata.subdomain}.${this.config.domain}`,
        domains: metadata.domains,
        size: metadata.size,
        version: metadata.version,
        deployedAt: metadata.deployedAt,
        oauth: metadata.oauth,
        persistentStorage: metadata.persistentStorage,
      }

      return this.json(siteInfo)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to deploy site"
      return this.error(message, 500)
    }
  }

  private handleUndeploy(subdomain: string): Response {
    if (!this.storage.siteExists(subdomain)) {
      return this.error("Site not found", 404)
    }

    // Delete site files, metadata, and persistent storage data
    const deleted = this.storage.deleteSite(subdomain)
    if (!deleted) {
      return this.error("Failed to delete site", 500)
    }
    this.persistentStorage.deleteSite(subdomain)

    // Update routing config to remove route for this site
    const allSites = this.storage.listSites()
    this.updateRoutingConfig(allSites)

    return this.json(null)
  }

  private async handleDownload(subdomain: string): Promise<Response> {
    if (!this.storage.siteExists(subdomain)) {
      return this.error("Site not found", 404)
    }

    try {
      const zipData = await this.storage.zipSite(subdomain)
      if (!zipData) {
        return this.error("Failed to create zip", 500)
      }

      return new Response(zipData, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${subdomain}.zip"`,
          "Content-Length": String(zipData.length),
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to download site"
      return this.error(message, 500)
    }
  }

  private async handleUpdateAuth(subdomain: string, req: Request): Promise<Response> {
    if (!this.storage.siteExists(subdomain)) {
      return this.error("Site not found", 404)
    }

    try {
      const body = (await req.json()) as {
        allowedEmails?: string[]
        allowedDomain?: string
        allowedGroups?: string[]
        remove?: boolean
      }

      let oauth: SiteOAuth | null = null

      if (body.remove) {
        // Remove OAuth
        oauth = null
      } else if (body.allowedEmails || body.allowedDomain || body.allowedGroups) {
        // Reject if OAuth is not configured on the server
        if (!this.hasOAuthEnabled()) {
          return this.error(
            "Google authentication not configured. Run 'siteio agent oauth' on the server to enable it.",
            400
          )
        }

        oauth = {}
        if (body.allowedEmails) {
          oauth.allowedEmails = body.allowedEmails.map((e) => e.toLowerCase())
        }
        if (body.allowedDomain) {
          oauth.allowedDomain = body.allowedDomain.toLowerCase()
        }
        if (body.allowedGroups) {
          oauth.allowedGroups = body.allowedGroups.map((g) => g.toLowerCase())
        }
      } else {
        return this.error("Provide allowedEmails, allowedDomain, or allowedGroups, or set remove: true")
      }

      const updated = this.storage.updateOAuth(subdomain, oauth)
      if (!updated) {
        return this.error("Failed to update authentication", 500)
      }

      // Update routing config with new OAuth settings
      const allSites = this.storage.listSites()
      this.updateRoutingConfig(allSites)

      return this.json(null)
    } catch (err) {
      return this.error("Invalid request body")
    }
  }

  private async handleUpdateDomains(subdomain: string, req: Request): Promise<Response> {
    if (!this.storage.siteExists(subdomain)) {
      return this.error("Site not found", 404)
    }

    try {
      const body = (await req.json()) as { domains?: string[] }

      if (!body.domains || !Array.isArray(body.domains)) {
        return this.error("'domains' array is required")
      }

      // Normalize domains to lowercase
      const domains = body.domains.map(d => d.toLowerCase())

      // Validate domain format
      const domainRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/
      for (const domain of domains) {
        if (!domainRegex.test(domain)) {
          return this.error(`Invalid domain format: ${domain}`)
        }
      }

      // Reject subdomains within the base domain space (e.g., api.example.com)
      // but allow the apex domain itself (e.g., example.com) as a custom domain
      const baseDomainSuffix = `.${this.config.domain}`
      for (const domain of domains) {
        if (domain.endsWith(baseDomainSuffix)) {
          return this.error(`Cannot use '${domain}' as a custom domain — it conflicts with the base domain subdomains`)
        }
      }

      // Check for conflicts with other sites
      const allSites = this.storage.listSites()
      for (const site of allSites) {
        if (site.subdomain === subdomain) continue
        if (site.domains) {
          const overlap = domains.filter(d => site.domains!.includes(d))
          if (overlap.length > 0) {
            return this.error(`Domain(s) already in use by site '${site.subdomain}': ${overlap.join(", ")}`)
          }
        }
      }

      // Check for conflicts with apps
      const allApps = this.appStorage.list()
      for (const app of allApps) {
        const overlap = domains.filter(d => app.domains.includes(d))
        if (overlap.length > 0) {
          return this.error(`Domain(s) already in use by app '${app.name}': ${overlap.join(", ")}`)
        }
      }

      const updated = this.storage.updateDomains(subdomain, domains)
      if (!updated) {
        return this.error("Failed to update domains", 500)
      }

      // Update routing config
      const updatedSites = this.storage.listSites()
      this.updateRoutingConfig(updatedSites)

      const metadata = this.storage.getMetadata(subdomain)!
      const siteInfo: SiteInfo = {
        subdomain: metadata.subdomain,
        url: `https://${metadata.subdomain}.${this.config.domain}`,
        domains: metadata.domains,
        size: metadata.size,
        version: metadata.version,
        deployedAt: metadata.deployedAt,
        oauth: metadata.oauth,
        persistentStorage: metadata.persistentStorage,
      }

      return this.json(siteInfo)
    } catch (err) {
      return this.error("Invalid request body")
    }
  }

  private async handleRename(subdomain: string, req: Request): Promise<Response> {
    if (!this.storage.siteExists(subdomain)) {
      return this.error("Site not found", 404)
    }

    try {
      const body = (await req.json()) as { newSubdomain?: string }

      if (!body.newSubdomain || typeof body.newSubdomain !== "string") {
        return this.error("'newSubdomain' is required")
      }

      const newSubdomain = body.newSubdomain.toLowerCase()

      if (!/^[a-z0-9-]+$/.test(newSubdomain)) {
        return this.error("Subdomain must contain only lowercase letters, numbers, and hyphens")
      }

      if (newSubdomain === "api") {
        return this.error("'api' is a reserved subdomain")
      }

      if (newSubdomain === subdomain) {
        return this.error("New subdomain is the same as the current one")
      }

      if (this.storage.siteExists(newSubdomain)) {
        return this.error(`Site '${newSubdomain}' already exists`)
      }

      const metadata = this.storage.renameSite(subdomain, newSubdomain)
      if (!metadata) {
        return this.error("Failed to rename site", 500)
      }

      // Update routing config
      const allSites = this.storage.listSites()
      this.updateRoutingConfig(allSites)

      const siteInfo: SiteInfo = {
        subdomain: metadata.subdomain,
        url: `https://${metadata.subdomain}.${this.config.domain}`,
        domains: metadata.domains,
        size: metadata.size,
        version: metadata.version,
        deployedAt: metadata.deployedAt,
        oauth: metadata.oauth,
        persistentStorage: metadata.persistentStorage,
      }

      return this.json(siteInfo)
    } catch (err) {
      return this.error("Invalid request body")
    }
  }

  private handleGetHistory(subdomain: string): Response {
    if (!this.storage.siteExists(subdomain)) {
      return this.error("Site not found", 404)
    }

    const history = this.storage.getHistory(subdomain)
    return this.json(history)
  }

  private async handleRollback(subdomain: string, req: Request): Promise<Response> {
    if (!this.storage.siteExists(subdomain)) {
      return this.error("Site not found", 404)
    }

    try {
      const body = (await req.json()) as { version: number }

      if (!body.version || typeof body.version !== "number") {
        return this.error("Version number is required")
      }

      const metadata = this.storage.rollback(subdomain, body.version)
      if (!metadata) {
        return this.error(`Version ${body.version} not found in history`, 404)
      }

      // Update routing config
      const allSites = this.storage.listSites()
      this.updateRoutingConfig(allSites)

      const siteInfo: SiteInfo = {
        subdomain: metadata.subdomain,
        url: `https://${metadata.subdomain}.${this.config.domain}`,
        domains: metadata.domains,
        size: metadata.size,
        version: metadata.version,
        deployedAt: metadata.deployedAt,
        oauth: metadata.oauth,
        persistentStorage: metadata.persistentStorage,
      }

      return this.json(siteInfo)
    } catch (err) {
      return this.error("Invalid request body")
    }
  }

  // Group handlers
  private handleListGroups(): Response {
    const groups = this.groups.list()
    return this.json(groups)
  }

  private handleGetGroup(name: string): Response {
    const group = this.groups.get(name)
    if (!group) {
      return this.error("Group not found", 404)
    }
    return this.json(group)
  }

  private async handleCreateGroup(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as { name: string; emails?: string[] }

      if (!body.name) {
        return this.error("Group name is required")
      }

      if (!/^[a-z0-9-]+$/.test(body.name.toLowerCase())) {
        return this.error("Group name must contain only lowercase letters, numbers, and hyphens")
      }

      const group = this.groups.create(body.name, body.emails || [])
      return this.json(group)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create group"
      return this.error(message, 400)
    }
  }

  private async handleUpdateGroup(name: string, req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as { emails: string[] }

      if (!body.emails) {
        return this.error("emails field is required")
      }

      const group = this.groups.update(name, body.emails)
      return this.json(group)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update group"
      return this.error(message, 400)
    }
  }

  private handleDeleteGroup(name: string): Response {
    try {
      this.groups.delete(name)
      return this.json(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete group"
      return this.error(message, 400)
    }
  }

  private async handleModifyGroupEmails(name: string, req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as { add?: string[]; remove?: string[] }

      if (!body.add && !body.remove) {
        return this.error("Provide 'add' or 'remove' array of emails")
      }

      let group: Group | null = null

      if (body.add) {
        group = this.groups.addEmails(name, body.add)
      }

      if (body.remove) {
        group = this.groups.removeEmails(name, body.remove)
      }

      return this.json(group)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to modify group"
      return this.error(message, 400)
    }
  }

  // App handlers
  private async handleListApps(): Promise<Response> {
    const apps = this.appStorage.list()

    // Get TLS status from Traefik if available
    const tlsStatusMap = this.traefik ? await this.traefik.getAllRoutersTlsStatus() : new Map()

    const appInfos: AppInfo[] = apps.map((app) => ({
      ...this.appStorage.toInfo(app, this.config.domain),
      tls: tlsStatusMap.get(`siteio-${app.name}`) || "pending",
    }))
    return this.json(appInfos)
  }

  private handleGetApp(name: string): Response {
    const app = this.appStorage.get(name)
    if (!app) {
      return this.error("App not found", 404)
    }
    return this.json(app)
  }

  private async handleCreateApp(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as {
        name: string
        type?: string
        image?: string
        git?: {
          repoUrl: string
          branch?: string
          dockerfile?: string
          context?: string
        }
        dockerfileContent?: string
        composeContent?: string
        composePath?: string
        envFileContent?: string
        primaryService?: string
        internalPort?: number
        domains?: string[]
        env?: Record<string, string>
        volumes?: Array<{ name: string; mountPath: string }>
        restartPolicy?: string
        oauth?: SiteOAuth
      }

      if (!body.name) {
        return this.error("App name is required")
      }

      const hasCompose = !!body.composeContent || !!body.composePath
      const hasGit = !!body.git
      const hasImage = !!body.image
      const hasInlineDockerfile = !!body.dockerfileContent

      // Mutual exclusivity: image / inline-dockerfile / compose / git.
      // git may coexist with composePath OR GitSource.dockerfile, not both.
      const primarySources = [hasImage, hasInlineDockerfile, hasCompose, hasGit].filter(Boolean).length
      if (primarySources === 0) {
        return this.error("Either image, git source, dockerfile, or compose is required")
      }
      if (hasImage && (hasInlineDockerfile || hasCompose || hasGit)) {
        return this.error("--image cannot be combined with other source flags")
      }
      if (hasInlineDockerfile && (hasCompose || hasGit)) {
        return this.error("--file cannot be combined with git or compose sources")
      }
      if (body.composeContent && body.composePath) {
        return this.error("Specify either composeContent (inline) or composePath (git), not both")
      }
      if (body.composePath && !hasGit) {
        return this.error("composePath requires --git")
      }
      if (hasCompose && !body.primaryService) {
        return this.error("primaryService is required when using a compose file")
      }
      if (!hasCompose && body.primaryService) {
        return this.error("primaryService is only valid with a compose source")
      }
      if (body.envFileContent && !hasCompose) {
        return this.error("envFileContent is only valid when a compose file is provided")
      }

      if (body.git && !body.git.repoUrl) {
        return this.error("Git repository URL is required")
      }

      // Determine image tag for locally-built or compose-tagged apps.
      const image =
        hasGit || hasInlineDockerfile || hasCompose
          ? this.docker.imageTag(body.name)
          : body.image!

      // Persist inline Dockerfile / compose file up-front; roll back on create failure.
      if (body.dockerfileContent) {
        this.dockerfiles.write(body.name, body.dockerfileContent)
      }
      if (body.composeContent) {
        this.compose.writeBaseInline(body.name, body.composeContent)
      }
      if (body.envFileContent) {
        this.compose.writeBaseEnv(body.name, body.envFileContent)
      }

      try {
        const composeField: App["compose"] = hasCompose
          ? body.composeContent
            ? { source: "inline", primaryService: body.primaryService! }
            : { source: "git", path: body.composePath!, primaryService: body.primaryService! }
          : undefined

        const app = this.appStorage.create({
          name: body.name,
          type: (body.type as "static" | "container") || "container",
          image,
          git: body.git
            ? {
                repoUrl: body.git.repoUrl,
                branch: body.git.branch || "main",
                dockerfile: body.git.dockerfile || "Dockerfile",
                context: body.git.context,
              }
            : undefined,
          dockerfile: body.dockerfileContent ? { source: "inline" } : undefined,
          compose: composeField,
          internalPort: body.internalPort || 80,
          domains: body.domains || [],
          env: body.env || {},
          volumes: body.volumes || [],
          restartPolicy: (body.restartPolicy as "always" | "unless-stopped" | "on-failure" | "no") || "unless-stopped",
          status: "pending",
          oauth: body.oauth,
        })

        return this.json(app)
      } catch (err) {
        if (body.dockerfileContent) this.dockerfiles.remove(body.name)
        if (body.composeContent) this.compose.remove(body.name)
        throw err
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create app"
      return this.error(message, 400)
    }
  }

  private async handleUpdateApp(name: string, req: Request): Promise<Response> {
    try {
      const app = this.appStorage.get(name)
      if (!app) {
        return this.error("App not found", 404)
      }

      const body = (await req.json()) as Partial<Omit<App, "name" | "createdAt">>
      const updated = this.appStorage.update(name, body)
      if (!updated) {
        return this.error("Failed to update app", 500)
      }

      return this.json(updated)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update app"
      return this.error(message, 400)
    }
  }

  private async handleDeleteApp(name: string): Promise<Response> {
    const app = this.appStorage.get(name)
    if (!app) {
      return this.error("App not found", 404)
    }

    if (app.compose) {
      try {
        const files = await this.composeFiles(app)
        await this.docker.composeDown(`siteio-${name}`, files, this.composeEnvFile(name))
      } catch {
        // Best-effort; the base file may be missing if the repo was cleaned up.
      }
      try {
        this.compose.remove(name)
      } catch {
        // Ignore
      }
    } else {
      if (this.docker.containerExists(name)) {
        try {
          await this.docker.remove(name)
        } catch {
          // Ignore
        }
      }
      if (app.dockerfile && this.dockerfiles.exists(name)) {
        try {
          this.dockerfiles.remove(name)
        } catch {
          // Ignore
        }
      }
      if (app.git || app.dockerfile) {
        try {
          const imageTag = this.docker.imageTag(name)
          await this.docker.removeImage(imageTag)
        } catch {
          // Ignore
        }
      }
    }

    if (app.git && this.git.exists(name)) {
      try {
        await this.git.remove(name)
      } catch {
        // Ignore
      }
    }

    const deleted = this.appStorage.delete(name)
    if (!deleted) {
      return this.error("Failed to delete app", 500)
    }
    return this.json(null)
  }

  private async handleDeployApp(name: string, url: URL, req: Request): Promise<Response> {
    const app = this.appStorage.get(name)
    if (!app) {
      return this.error("App not found", 404)
    }

    const noCache = url.searchParams.get("noCache") === "true"

    // Optional JSON body lets the client push a fresh Dockerfile at deploy time
    // (for inline-dockerfile apps only). The body is optional — bare POSTs still work.
    let newDockerfileContent: string | undefined
    const contentType = req.headers.get("Content-Type") || ""
    if (contentType.includes("application/json")) {
      try {
        const body = (await req.json()) as { dockerfileContent?: string }
        newDockerfileContent = body.dockerfileContent
      } catch {
        // Empty or malformed body — ignore, treat as bare deploy
      }
    }

    if (newDockerfileContent && !app.dockerfile) {
      return this.error("Cannot override Dockerfile: app was not created with -f", 400)
    }

    try {
      // Check Docker availability
      if (!this.docker.isAvailable()) {
        return this.error("Docker is not available", 500)
      }

      const { existsSync } = await import("fs")
      const { join } = await import("path")

      // ---------- COMPOSE BRANCH ----------
      if (app.compose) {
        // Ensure Traefik can reach the service
        this.docker.ensureNetwork()

        // Resolve base compose file
        let basePath: string
        if (app.compose.source === "inline") {
          basePath = this.compose.baseInlinePath(name)
          if (!existsSync(basePath)) {
            this.appStorage.update(name, { status: "failed" })
            return this.error("Compose file not found for app", 400)
          }
        } else {
          if (!app.git) {
            this.appStorage.update(name, { status: "failed" })
            return this.error("Git source missing on compose app", 500)
          }
          await this.git.clone(name, app.git.repoUrl, app.git.branch)
          const repoPath = this.git.repoPath(name)
          basePath = join(repoPath, app.compose.path)
          if (!existsSync(basePath)) {
            this.appStorage.update(name, { status: "failed" })
            return this.error(`Compose file not found at '${app.compose.path}'`, 400)
          }
        }

        // Write the override (regenerate every deploy so env/domain/oauth updates apply)
        const overrideYaml = buildOverride(app, this.config.dataDir)
        this.compose.writeOverride(name, overrideYaml)
        const overridePath = this.compose.overridePath(name)

        const project = `siteio-${name}`
        const files = [basePath, overridePath]
        const envFile = this.composeEnvFile(name)

        // Validate config (parses + merges both files via compose-go)
        const spec = await this.docker.composeConfig(project, files, envFile)
        if (!spec.services || !spec.services[app.compose.primaryService]) {
          this.appStorage.update(name, { status: "failed" })
          return this.error(
            `Primary service '${app.compose.primaryService}' not found in compose file. Available: ${Object.keys(spec.services || {}).join(", ") || "none"}`,
            400
          )
        }

        // Compute deploy-time warnings from the merged config
        const warnings = this.computeComposeWarnings(spec, app.compose.primaryService)

        // Bring up the project
        await this.docker.composeUp(project, files, envFile)

        // Resolve primary service's container ID via ps
        const psOutput = await this.docker.composePs(project, files, envFile)
        const primaryState = psOutput.find((s) => s.service === app.compose!.primaryService)

        const composeCommitHash = app.compose.source === "git" ? await this.git.getCommitHash(name) : undefined
        const composeLastBuildAt = new Date().toISOString()

        const updatedCompose = this.appStorage.update(name, {
          status: "running",
          containerId: primaryState?.containerId,
          deployedAt: new Date().toISOString(),
          lastBuildAt: composeLastBuildAt,
          ...(composeCommitHash && { commitHash: composeCommitHash }),
        })

        return this.json({ ...updatedCompose, warnings })
      }
      // ---------- END COMPOSE BRANCH ----------

      // Ensure network exists (container flow)
      this.docker.ensureNetwork()

      // Remove existing container if it exists
      if (this.docker.containerExists(name)) {
        await this.docker.remove(name)
      }

      let imageToRun: string
      let commitHash: string | undefined
      let lastBuildAt: string | undefined

      if (app.git) {
        // Git-based app: clone and build

        // Clone repository
        await this.git.clone(name, app.git.repoUrl, app.git.branch)

        const repoPath = this.git.repoPath(name)

        // Determine build context path
        const contextPath = app.git.context ? join(repoPath, app.git.context) : repoPath

        // Validate context directory exists
        if (app.git.context && !existsSync(contextPath)) {
          return this.error(`Context directory not found at '${app.git.context}'`, 400)
        }

        // Validate Dockerfile exists (path is relative to repo root, like docker -f)
        const dockerfilePath = join(repoPath, app.git.dockerfile)
        if (!existsSync(dockerfilePath)) {
          return this.error(`Dockerfile not found at '${app.git.dockerfile}'`, 400)
        }

        // Build image
        const imageTag = this.docker.imageTag(name)
        await this.docker.build({
          contextPath,
          dockerfilePath,
          tag: imageTag,
          noCache,
        })

        // Get commit hash
        commitHash = await this.git.getCommitHash(name)
        lastBuildAt = new Date().toISOString()
        imageToRun = imageTag
      } else if (app.dockerfile) {
        // Inline-dockerfile app: build from the stored Dockerfile in an empty context.
        // The Dockerfile must be self-contained (no COPY/ADD from context).
        if (newDockerfileContent) {
          this.dockerfiles.write(name, newDockerfileContent)
        }

        if (!this.dockerfiles.exists(name)) {
          return this.error("Dockerfile not found for app — re-run deploy with -f", 400)
        }

        const imageTag = this.docker.imageTag(name)
        await this.docker.build({
          contextPath: this.dockerfiles.contextPath(name),
          dockerfilePath: this.dockerfiles.dockerfilePath(name),
          tag: imageTag,
          noCache,
        })

        lastBuildAt = new Date().toISOString()
        imageToRun = imageTag
      } else {
        // Image-based app: pull from registry
        await this.docker.pull(app.image)
        imageToRun = app.image
      }

      // Build Traefik labels for routing
      // Use default subdomain if no custom domains specified
      const domains = app.domains.length > 0 ? app.domains : [`${name}.${this.config.domain}`]
      const labels = this.docker.buildTraefikLabels(name, domains, app.internalPort)

      // Run container
      const containerId = await this.docker.run({
        name: app.name,
        image: imageToRun,
        internalPort: app.internalPort,
        env: app.env,
        volumes: app.volumes,
        restartPolicy: app.restartPolicy,
        network: "siteio-network",
        labels,
      })

      // Update app status
      const updated = this.appStorage.update(name, {
        status: "running",
        containerId,
        deployedAt: new Date().toISOString(),
        ...(commitHash && { commitHash }),
        ...(lastBuildAt && { lastBuildAt }),
      })

      return this.json(updated)
    } catch (err) {
      // Update status to failed
      this.appStorage.update(name, { status: "failed" })
      const message = err instanceof Error ? err.message : "Failed to deploy app"
      return this.error(message, 500)
    }
  }

  private async handleStopApp(name: string): Promise<Response> {
    const app = this.appStorage.get(name)
    if (!app) {
      return this.error("App not found", 404)
    }
    try {
      if (app.compose) {
        const files = await this.composeFiles(app)
        await this.docker.composeStop(`siteio-${name}`, files, this.composeEnvFile(name))
      } else if (this.docker.containerExists(name)) {
        await this.docker.stop(name)
      }
      const updated = this.appStorage.update(name, { status: "stopped" })
      return this.json(updated)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to stop app"
      return this.error(message, 500)
    }
  }

  private async handleRestartApp(name: string): Promise<Response> {
    const app = this.appStorage.get(name)
    if (!app) {
      return this.error("App not found", 404)
    }
    try {
      if (app.compose) {
        const files = await this.composeFiles(app)
        await this.docker.composeRestart(`siteio-${name}`, files, this.composeEnvFile(name))
        const updated = this.appStorage.update(name, { status: "running" })
        return this.json(updated)
      }
      if (this.docker.containerExists(name)) {
        await this.docker.restart(name)
        const updated = this.appStorage.update(name, { status: "running" })
        return this.json(updated)
      }
      return this.error("Container does not exist. Deploy the app first.", 400)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to restart app"
      return this.error(message, 500)
    }
  }

  private async handleGetAppLogs(name: string, url: URL): Promise<Response> {
    const app = this.appStorage.get(name)
    if (!app) {
      return this.error("App not found", 404)
    }

    const tail = parseInt(url.searchParams.get("tail") || "100", 10)
    const service = url.searchParams.get("service") || undefined
    const all = url.searchParams.get("all") === "true"

    if ((service || all) && !app.compose) {
      return this.error("`service` and `all` are only valid on compose-based apps", 400)
    }

    try {
      let logs: string
      if (app.compose) {
        const files = await this.composeFiles(app)
        logs = await this.docker.composeLogs(`siteio-${name}`, files, this.composeEnvFile(name), {
          tail,
          all,
          service: all ? undefined : (service ?? app.compose.primaryService),
        })
      } else {
        logs = await this.docker.logs(name, tail)
      }

      const response: ContainerLogs = { name, logs, lines: tail }
      return this.json(response)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to get logs"
      return this.error(message, 500)
    }
  }

  // Persistent storage handlers

  private handleStorageShim(): Response {
    return new Response(STORAGE_SHIM_JS, {
      headers: {
        "Content-Type": "application/javascript",
        "Cache-Control": "public, max-age=3600",
      },
    })
  }

  private handleStorageGet(host: string, req: Request): Response {
    const subdomain = this.extractSubdomain(host, req)
    if (!subdomain) return this.error("Unknown site", 404)
    const meta = this.storage.getMetadata(subdomain)
    if (!meta?.persistentStorage) return this.error("Storage not enabled", 404)
    const email = req.headers.get("X-Auth-Request-Email") || undefined
    const data = this.persistentStorage.get(subdomain, email) || {}
    return Response.json(data)
  }

  private async handleStoragePut(host: string, req: Request): Promise<Response> {
    const subdomain = this.extractSubdomain(host, req)
    if (!subdomain) return this.error("Unknown site", 404)
    const meta = this.storage.getMetadata(subdomain)
    if (!meta?.persistentStorage) return this.error("Storage not enabled", 404)
    const email = req.headers.get("X-Auth-Request-Email") || undefined
    try {
      const body = (await req.json()) as Record<string, string>
      this.persistentStorage.set(subdomain, body, email)
      return Response.json({ ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to store data"
      const status = message.includes("exceeds limit") ? 413 : 400
      return this.error(message, status)
    }
  }

  private async handleToggleStorage(subdomain: string, req: Request): Promise<Response> {
    if (!this.storage.siteExists(subdomain)) {
      return this.error("Site not found", 404)
    }
    try {
      const body = (await req.json()) as { enabled: boolean }
      const updated = this.storage.updatePersistentStorage(subdomain, body.enabled)
      if (!updated) return this.error("Failed to update", 500)
      const allSites = this.storage.listSites()
      this.updateRoutingConfig(allSites)
      return this.json({ persistentStorage: body.enabled })
    } catch (err) {
      return this.error("Invalid request body")
    }
  }

  private extractSubdomain(host: string, req?: Request): string | null {
    // In test/dev mode, allow specifying subdomain via header
    const headerSubdomain = req?.headers.get("X-Site-Subdomain")
    if (headerSubdomain) {
      return headerSubdomain
    }
    const suffix = `.${this.config.domain}`
    if (host.endsWith(suffix)) {
      return host.slice(0, -suffix.length)
    }
    return null
  }

  // Helper to check if an email is authorized for an OAuth config
  private checkOAuthAuthorization(
    oauth: SiteOAuth,
    email: string,
    domain: string,
    originalUrl: string
  ): Response {
    // Check allowedEmails
    if (oauth.allowedEmails && oauth.allowedEmails.length > 0) {
      if (oauth.allowedEmails.map((e) => e.toLowerCase()).includes(email)) {
        return new Response(null, { status: 200 })
      }
    }

    // Check allowedDomain
    if (oauth.allowedDomain) {
      const emailDomain = email.split("@")[1]
      if (emailDomain === oauth.allowedDomain.toLowerCase()) {
        return new Response(null, { status: 200 })
      }
    }

    // Check allowedGroups
    if (oauth.allowedGroups && oauth.allowedGroups.length > 0) {
      const groupEmails = this.groups.resolveGroups(oauth.allowedGroups)
      if (groupEmails.includes(email)) {
        return new Response(null, { status: 200 })
      }
    }

    // If no restrictions are set, allow all authenticated users
    const hasEmailRestrictions = oauth.allowedEmails && oauth.allowedEmails.length > 0
    const hasDomainRestriction = !!oauth.allowedDomain
    const hasGroupRestrictions = oauth.allowedGroups && oauth.allowedGroups.length > 0
    if (!hasEmailRestrictions && !hasDomainRestriction && !hasGroupRestrictions) {
      return new Response(null, { status: 200 })
    }

    // None of the checks passed - return styled 403 page
    const signOutUrl = `https://auth.${domain}/oauth2/sign_out?rd=${encodeURIComponent(originalUrl)}`
    const safeEmail = this.escapeHtml(email)
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Access Denied</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .container { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 400px; }
    h1 { color: #dc3545; margin-bottom: 1rem; }
    .email { color: #666; margin-bottom: 1.5rem; word-break: break-all; }
    a { color: #007bff; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Access Denied</h1>
    <p class="email">Signed in as: <strong>${safeEmail}</strong></p>
    <p><a href="${signOutUrl}">Sign out and try another account</a></p>
  </div>
</body>
</html>`
    return new Response(html, {
      status: 403,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  }

  // Auth check for Traefik forwardAuth middleware
  private handleAuthCheck(req: Request): Response {
    const host = req.headers.get("host") || req.headers.get("x-forwarded-host") || ""
    const hostWithoutPort = host.split(":")[0] || ""

    const domainSuffix = `.${this.config.domain}`

    let oauth: SiteOAuth | undefined

    if (hostWithoutPort.endsWith(domainSuffix)) {
      // Standard subdomain match (e.g., "myapp.test.siteio.me" -> "myapp")
      const subdomain = hostWithoutPort.slice(0, -domainSuffix.length)
      if (!subdomain || subdomain === "api") {
        return new Response(null, { status: 200 })
      }

      // Look up OAuth config from app or site
      const app = this.appStorage.get(subdomain)
      if (app) {
        oauth = app.oauth
      } else {
        const site = this.storage.getMetadata(subdomain)
        if (site) {
          oauth = site.oauth
        }
      }
    } else {
      // Custom domain — reverse lookup across sites
      const allSites = this.storage.listSites()
      const matchingSite = allSites.find(s => s.domains?.includes(hostWithoutPort))
      if (matchingSite) {
        oauth = matchingSite.oauth
      }
      // Also check apps (they already support custom domains)
      if (!oauth) {
        const allApps = this.appStorage.list()
        const matchingApp = allApps.find(a => a.domains.includes(hostWithoutPort))
        if (matchingApp) {
          oauth = matchingApp.oauth
        }
      }
    }

    // No OAuth configured (or resource not found), allow access
    if (!oauth) {
      return new Response(null, { status: 200 })
    }

    // OAuth is required - check for authenticated user
    // oauth2-proxy sends X-Forwarded-Email in reverse proxy mode
    // and X-Auth-Request-Email in forwardAuth mode
    const email = (req.headers.get("X-Forwarded-Email") || req.headers.get("X-Auth-Request-Email"))?.toLowerCase()
    if (!email) {
      return new Response("Authentication required", { status: 401 })
    }

    // Construct the original URL for the logout redirect
    const proto = req.headers.get("X-Forwarded-Proto") || "https"
    const uri = req.headers.get("X-Forwarded-Uri") || req.headers.get("X-Original-URL") || "/"
    const originalUrl = `${proto}://${host}${uri}`

    return this.checkOAuthAuthorization(oauth, email, this.config.domain, originalUrl)
  }

  async start(): Promise<void> {
    // Run lazy OIDC discovery migration for legacy oauth configs. Safe no-op if
    // no config exists or it has already been discovered.
    const discovered = await ensureDiscoveredConfig(this.config.dataDir)
    if (discovered) {
      this.oauthConfig = discovered
      if (this.traefik) {
        this.traefik.updateOAuthConfig(discovered)
      }
    }

    // Start Traefik (if enabled)
    if (this.traefik) {
      await this.traefik.start()
      const existingSites = this.storage.listSites()
      this.traefik.updateDynamicConfig(existingSites)
      this.traefik.updateNginxConfig(existingSites)
      this.traefik.reloadNginx()
    }

    const port = this.config.port || 3000

    // Start HTTP server
    this.server = Bun.serve({
      port,
      fetch: (req) => this.handleRequest(req),
    })

    console.log(`> API server listening on port ${port}`)
    console.log(`> Domain: ${this.config.domain}`)
    console.log(`> API URL: https://api.${this.config.domain}`)
    console.log(`> API Key: ${this.config.apiKey}`)
  }

  /**
   * Resolve the env-file path for a compose app if one was uploaded, else undefined.
   */
  private composeEnvFile(appName: string): string | undefined {
    return this.compose.envFileExists(appName) ? this.compose.baseEnvPath(appName) : undefined
  }

  /**
   * Compute deploy-time warnings from a merged compose config. These are hints
   * about patterns that work but aren't ideal for siteio-managed apps:
   *   - The primary service publishes `ports:` (Traefik handles external access;
   *     host-side binding is redundant and may conflict with other apps).
   *   - Any service sets `container_name:` (fixed names prevent multi-instance).
   */
  private computeComposeWarnings(
    spec: import("./compose.ts").ComposeSpec,
    primaryService: string
  ): string[] {
    const warnings: string[] = []
    const services = spec.services ?? {}

    const primary = services[primaryService] as { ports?: unknown[] } | undefined
    if (primary && Array.isArray(primary.ports) && primary.ports.length > 0) {
      warnings.push(
        `Primary service '${primaryService}' publishes ports (${JSON.stringify(primary.ports)}). Traefik handles external access; host port bindings are redundant and may conflict with other apps on the same server.`
      )
    }

    for (const [serviceName, serviceDef] of Object.entries(services)) {
      const svc = serviceDef as { container_name?: string } | undefined
      if (svc?.container_name) {
        warnings.push(
          `Service '${serviceName}' sets container_name='${svc.container_name}'. Fixed container names prevent deploying multiple instances of this app.`
        )
      }
    }

    return warnings
  }

  /**
   * Resolve the [base, override] compose file paths for a compose-based app.
   * For git apps the base lives inside the cloned repo (which must already exist
   * from a prior deploy — lifecycle ops never re-clone).
   */
  private async composeFiles(app: App): Promise<string[]> {
    if (!app.compose) {
      throw new Error(`composeFiles called on non-compose app '${app.name}'`)
    }
    const { join } = await import("path")
    const basePath =
      app.compose.source === "inline"
        ? this.compose.baseInlinePath(app.name)
        : join(this.git.repoPath(app.name), app.compose.path)
    return [basePath, this.compose.overridePath(app.name)]
  }

  stop(): void {
    this.traefik?.stop()
    if (this.server) {
      this.server.stop()
      this.server = null
    }
  }
}
