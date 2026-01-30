import type { AgentConfig, AgentOAuthConfig, ApiResponse, SiteInfo, SiteOAuth, Group, App, AppInfo, ContainerLogs } from "../../types.ts"
import { SiteStorage } from "./storage.ts"
import { TraefikManager } from "./traefik.ts"
import { loadOAuthConfig } from "../../config/oauth.ts"
import { GroupStorage } from "./groups.ts"
import { AppStorage } from "./app-storage.ts"
import { DockerManager } from "./docker.ts"
import { GitManager } from "./git.ts"

export class AgentServer {
  private config: AgentConfig
  private storage: SiteStorage
  private groups: GroupStorage
  private appStorage: AppStorage
  private docker: DockerManager
  private git: GitManager
  private traefik: TraefikManager | null = null
  private server: ReturnType<typeof Bun.serve> | null = null
  private oauthConfig: AgentOAuthConfig | null = null

  constructor(config: AgentConfig) {
    this.config = config
    this.storage = new SiteStorage(config.dataDir)
    this.groups = new GroupStorage(config.dataDir)
    this.appStorage = new AppStorage(config.dataDir)
    this.docker = new DockerManager(config.dataDir)
    this.git = new GitManager(config.dataDir)

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
        oauthConfig: this.oauthConfig || undefined,
      })
    }
  }

  hasOAuthEnabled(): boolean {
    return this.oauthConfig !== null
  }

  private json<T>(data: T, status = 200): Response {
    return Response.json({ success: true, data } as ApiResponse<T>, { status })
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
    const hostWithoutPort = host.split(":")[0]

    // Auth check for Traefik forwardAuth (no auth required - called by Traefik)
    // This must be checked BEFORE the API/static routing because Traefik
    // forwards the original Host header of the request being authorized
    if (path === "/auth/check" && req.method === "GET") {
      return this.handleAuthCheck(req)
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
      return this.handleDeployApp(appDeployMatch[1]!, url)
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
      size: site.size,
      deployedAt: site.deployedAt,
      oauth: site.oauth,
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
      // Read the zip data
      const zipData = new Uint8Array(await req.arrayBuffer())

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
      const metadata = await this.storage.extractAndStore(subdomain, zipData, oauth)

      // Update Traefik dynamic config to add route for this site
      // Static sites are served by the shared nginx container
      const allSites = this.storage.listSites()
      this.traefik?.updateDynamicConfig(allSites)

      const siteInfo: SiteInfo = {
        subdomain: metadata.subdomain,
        url: `https://${metadata.subdomain}.${this.config.domain}`,
        size: metadata.size,
        deployedAt: metadata.deployedAt,
        oauth: metadata.oauth,
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

    // Delete site files and metadata
    const deleted = this.storage.deleteSite(subdomain)
    if (!deleted) {
      return this.error("Failed to delete site", 500)
    }

    // Update Traefik config to remove route for this site
    const allSites = this.storage.listSites()
    this.traefik?.updateDynamicConfig(allSites)

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

      // Update Traefik config with new OAuth settings
      const allSites = this.storage.listSites()
      this.traefik?.updateDynamicConfig(allSites)

      return this.json(null)
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
      ...this.appStorage.toInfo(app),
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

      // Must provide either image or git, but not both
      if (body.image && body.git) {
        return this.error("Cannot specify both image and git source")
      }

      if (!body.image && !body.git) {
        return this.error("Either image or git source is required")
      }

      // For git sources, validate required fields
      if (body.git && !body.git.repoUrl) {
        return this.error("Git repository URL is required")
      }

      // Determine the image name
      let image: string
      if (body.git) {
        // For git-based apps, use a local image tag
        image = this.docker.imageTag(body.name)
      } else {
        image = body.image!
      }

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

    // Stop container if running
    if (this.docker.containerExists(name)) {
      try {
        await this.docker.remove(name)
      } catch {
        // Ignore errors when removing container
      }
    }

    // Clean up git repo if it exists
    if (app.git && this.git.exists(name)) {
      try {
        await this.git.remove(name)
      } catch {
        // Ignore errors when removing repo
      }
    }

    // Clean up built image if it's a git-based app
    if (app.git) {
      try {
        const imageTag = this.docker.imageTag(name)
        await this.docker.removeImage(imageTag)
      } catch {
        // Ignore errors when removing image
      }
    }

    const deleted = this.appStorage.delete(name)
    if (!deleted) {
      return this.error("Failed to delete app", 500)
    }

    return this.json(null)
  }

  private async handleDeployApp(name: string, url: URL): Promise<Response> {
    const app = this.appStorage.get(name)
    if (!app) {
      return this.error("App not found", 404)
    }

    const noCache = url.searchParams.get("noCache") === "true"

    try {
      // Check Docker availability
      if (!this.docker.isAvailable()) {
        return this.error("Docker is not available", 500)
      }

      // Ensure network exists
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
        const { existsSync } = await import("fs")
        const { join } = await import("path")

        // Clone repository
        await this.git.clone(name, app.git.repoUrl, app.git.branch)

        const repoPath = this.git.repoPath(name)

        // Determine build context path
        const contextPath = app.git.context ? join(repoPath, app.git.context) : repoPath

        // Validate Dockerfile exists
        const dockerfilePath = join(contextPath, app.git.dockerfile)
        if (!existsSync(dockerfilePath)) {
          return this.error(`Dockerfile not found at '${app.git.dockerfile}'`, 400)
        }

        // Build image
        const imageTag = this.docker.imageTag(name)
        await this.docker.build({
          contextPath,
          dockerfile: app.git.dockerfile,
          tag: imageTag,
          noCache,
        })

        // Get commit hash
        commitHash = await this.git.getCommitHash(name)
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
      if (this.docker.containerExists(name)) {
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
      if (this.docker.containerExists(name)) {
        await this.docker.restart(name)
        const updated = this.appStorage.update(name, { status: "running" })
        return this.json(updated)
      } else {
        return this.error("Container does not exist. Deploy the app first.", 400)
      }
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

    try {
      const tail = parseInt(url.searchParams.get("tail") || "100", 10)
      const logs = await this.docker.logs(name, tail)

      const response: ContainerLogs = {
        name,
        logs,
        lines: tail,
      }

      return this.json(response)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to get logs"
      return this.error(message, 500)
    }
  }

  // Helper to check if an email is authorized for an OAuth config
  private checkOAuthAuthorization(oauth: SiteOAuth, email: string): Response {
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

    // None of the checks passed - forbidden
    return new Response("Access denied", { status: 403 })
  }

  // Auth check for Traefik forwardAuth middleware
  private handleAuthCheck(req: Request): Response {
    const host = req.headers.get("host") || req.headers.get("x-forwarded-host") || ""
    const hostWithoutPort = host.split(":")[0] || ""

    // Extract subdomain from host (e.g., "myapp.test.siteio.me" -> "myapp")
    const domainSuffix = `.${this.config.domain}`
    if (!hostWithoutPort || !hostWithoutPort.endsWith(domainSuffix)) {
      // Not a request for our domain, allow passthrough
      return new Response(null, { status: 200 })
    }

    const subdomain = hostWithoutPort.slice(0, -domainSuffix.length)
    if (!subdomain || subdomain === "api") {
      // API requests or invalid names, allow passthrough
      return new Response(null, { status: 200 })
    }

    // Look up OAuth config from app or site
    let oauth: SiteOAuth | undefined

    // First check if it's a Docker app
    const app = this.appStorage.get(subdomain)
    if (app) {
      oauth = app.oauth
    } else {
      // Not an app, check if it's a static site
      const site = this.storage.getMetadata(subdomain)
      if (site) {
        oauth = site.oauth
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
      // Not authenticated
      return new Response("Authentication required", { status: 401 })
    }

    // Check authorization against the OAuth config
    return this.checkOAuthAuthorization(oauth, email)
  }

  async start(): Promise<void> {
    // Start Traefik (if enabled)
    if (this.traefik) {
      await this.traefik.start()
      const existingSites = this.storage.listSites()
      this.traefik.updateDynamicConfig(existingSites)
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

  stop(): void {
    this.traefik?.stop()
    if (this.server) {
      this.server.stop()
      this.server = null
    }
  }
}
