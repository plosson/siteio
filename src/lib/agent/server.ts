import { mkdirSync } from "fs"
import { createHash } from "node:crypto"
import { unzipSync, zipSync } from "fflate"
import type { AgentConfig, ApiResponse, SiteInfo, App, AppInfo, ContainerLogs, Site, ShareGrant } from "../../types.ts"
import { SiteStorage } from "./storage.ts"
import { TraefikManager } from "./traefik.ts"
import { ThumbnailManager } from "./thumbnails.ts"
import { AppStorage } from "./app-storage.ts"
import { GrantStore, type CreateGrantInput } from "./grant-store.ts"
import { StagingStore } from "./staging-store.ts"
import { mergeScopedDeploy } from "./deploy-merge.ts"
import { OAuthStore } from "./oauth-store.ts"
import { OAuthProvider } from "./oauth-provider.ts"
import { McpHandler } from "./mcp.ts"
import { DockerManager } from "./docker.ts"
import type { Runtime } from "./runtime.ts"
import { GitManager } from "./git.ts"
import { DockerfileStorage } from "./dockerfile-storage.ts"
import { ComposeStorage } from "./compose-storage.ts"
import { buildOverride } from "./compose-override.ts"
import { ADMIN_UI_HTML, ADMIN_UI_JS, ADMIN_UI_CSS } from "./ui/assets.ts"
import { POCKETBASE_IMAGE, POCKETBASE_VERSION } from "../pocketbase-version.ts"
import { getVersion } from "../version.ts"
import { encodeToken } from "../../utils/token.ts"
import { assertSafePublicUrl } from "../../utils/ssrf.ts"
import { ValidationError } from "../../utils/errors.ts"
import { hasLegacySites, migrateLegacySites } from "./legacy-migration.ts"

// Strip the git token before returning an app over the API. Clients never need
// the raw value; they can set/clear it via PATCH. `tokenSet` is surfaced so
// UIs can indicate whether a token is stored.
function scrubApp<T extends App | AppInfo>(app: T): T {
  if (!app.git) return app
  const { token, ...rest } = app.git
  return { ...app, git: { ...rest, tokenSet: !!token } }
}

export class AgentServer {
  private config: AgentConfig
  private storage: SiteStorage
  private appStorage: AppStorage
  private grants: GrantStore
  private staging: StagingStore
  private oauth: OAuthStore
  private oauthProvider: OAuthProvider
  private mcp: McpHandler
  private docker: Runtime
  private git: GitManager
  private dockerfiles: DockerfileStorage
  private compose: ComposeStorage
  private traefik: TraefikManager | null = null
  // Generates site card previews via an on-demand browserless container. Null in
  // test mode (skipTraefik) so tests never touch real Docker.
  private thumbnails: ThumbnailManager | null = null
  private server: ReturnType<typeof Bun.serve> | null = null

  constructor(config: AgentConfig, runtime?: Runtime, hooks?: { fetchAsset?: (url: string) => Promise<Uint8Array> }) {
    this.config = config
    this.storage = new SiteStorage(config.dataDir)
    this.appStorage = new AppStorage(config.dataDir)
    this.grants = new GrantStore(config.dataDir)
    this.staging = new StagingStore(config.dataDir)
    this.oauth = new OAuthStore(config.dataDir)
    this.docker = runtime ?? new DockerManager(config.dataDir)
    this.git = new GitManager(config.dataDir)
    this.dockerfiles = new DockerfileStorage(config.dataDir)
    this.compose = new ComposeStorage(config.dataDir)
    this.oauthProvider = new OAuthProvider({
      grants: this.grants,
      oauth: this.oauth,
      sites: this.storage,
      domain: config.domain,
    })
    this.mcp = new McpHandler({
      grants: this.grants,
      staging: this.staging,
      sites: this.storage,
      oauth: this.oauth,
      domain: config.domain,
      deploy: (siteName, zipData, deployedBy, message) => this.deploySiteViaGrant(siteName, zipData, deployedBy, message),
      fetchAsset: hooks?.fetchAsset ?? ((url) => this.fetchExternalAsset(url)),
    })

    if (!config.skipTraefik) {
      this.traefik = new TraefikManager({
        dataDir: config.dataDir,
        domain: config.domain,
        email: config.email,
        httpPort: config.httpPort,
        httpsPort: config.httpsPort,
        fileServerPort: config.port || 3000,
        acme: config.acme,
      })
      this.thumbnails = new ThumbnailManager(config.dataDir)
    }
  }

  private json<T>(data: T, status = 200): Response {
    return Response.json({ success: true, data } as ApiResponse<T>, { status })
  }

  private error(message: string, status = 400): Response {
    return Response.json({ success: false, error: message } as ApiResponse<null>, { status })
  }

  // Resolve who is calling. The god API key grants full access; a share-grant
  // token (sent as X-API-Key by a scoped CLI login) grants a narrow, per-site
  // scope enforced in handleScopedRequest.
  private authenticate(req: Request): { kind: "god" } | { kind: "grant"; grant: ShareGrant } | null {
    const key = req.headers.get("X-API-Key") || ""
    if (!key) return null
    if (key === this.config.apiKey) return { kind: "god" }
    // A raw share code (grant token), as sent by a scoped CLI login.
    const grant = this.grants.resolveByToken(key)
    if (grant) return { kind: "grant", grant }
    return null
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)
    let path = url.pathname
    const host = req.headers.get("host") || ""
    const hostWithoutPort = host.split(":")[0] || ""

    // The MCP surface (`/mcp`, full web-file editing tools) + its per-site OAuth
    // authorization server, served under the SITE host (`<site>.<domain>`) —
    // never under api.<domain> and never behind the god key. Traefik forwards
    // `/mcp/*` and the oauth `.well-known/*` here, so this runs BEFORE the
    // api-host gate. Authenticated by an OAuth bearer → grant for this site.
    const isMcpSurface =
      path === "/mcp" || path.startsWith("/mcp/") ||
      path.startsWith("/.well-known/oauth-")
    if (isMcpSurface) {
      const ctx = this.oauthProvider.hostContext(host)
      if (!ctx) return this.error("Not found", 404)
      if (req.method === "OPTIONS") return this.oauthProvider.preflight()

      // Protected-resource metadata (RFC 9728). The bare path and the /mcp
      // suffix both resolve to the MCP resource.
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
        return this.oauthProvider.protectedResourceMetadata(ctx)
      }
      if (
        path === "/.well-known/oauth-authorization-server" ||
        path === "/.well-known/oauth-authorization-server/mcp"
      ) {
        return this.oauthProvider.authorizationServerMetadata(ctx)
      }
      if (path === "/mcp/oauth/register" && req.method === "POST") return this.oauthProvider.handleRegister(req)
      if (path === "/mcp/oauth/authorize") {
        if (req.method === "GET") return this.oauthProvider.handleAuthorizeGet(url, ctx)
        if (req.method === "POST") return this.oauthProvider.handleAuthorizePost(req, ctx)
      }
      if (path === "/mcp/oauth/token" && req.method === "POST") return this.oauthProvider.handleToken(req, ctx)
      // Out-of-band asset upload: authorized by the ticket in the path (not the
      // OAuth bearer), so curl / the user can PUT a local file straight into
      // staging. See McpHandler.handleAssetUpload / create_asset_upload.
      if (path.startsWith("/mcp/upload/")) {
        return this.mcp.handleAssetUpload(req, ctx, path.slice("/mcp/upload/".length))
      }
      if (path === "/mcp") return this.mcp.handle(req, ctx)

      return this.error("Not found", 404)
    }

    // Scoped-CLI REST channel, served under the SITE host so api.<domain> stays
    // hidden. Traefik routes `<site>.<domain>/_siteio/*` here. The standard
    // siteio CLI reaches it by logging in with a scoped token whose URL is
    // `https://<site>.<domain>/_siteio` — it then appends /sites/... etc. as
    // usual. Authenticated by a share code (grant token) as X-API-Key.
    if (path === "/_siteio" || path.startsWith("/_siteio/")) {
      const ctx = this.oauthProvider.hostContext(host)
      if (!ctx) return this.error("Not found", 404)
      const rest = path.slice("/_siteio".length) || "/"
      // Health is unauthenticated (CLI version-skew probe), like /health.
      if (rest === "/health" && req.method === "GET") {
        return this.json({ status: "ok", version: getVersion() })
      }
      const auth = this.authenticate(req)
      if (!auth) return this.error("Unauthorized", 401)
      if (auth.kind !== "grant") {
        return this.error("The management API is not available here; use a share code", 403)
      }
      if (auth.grant.site !== ctx.site) {
        return this.error("This share code is not valid for that site", 403)
      }
      return this.handleScopedRequest(auth.grant, rest, req)
    }

    // Check if this is an API request (api.domain)
    const isApiRequest = hostWithoutPort === `api.${this.config.domain}` ||
      hostWithoutPort === "localhost" ||
      hostWithoutPort === "127.0.0.1"

    if (!isApiRequest) {
      // Non-API requests are routed by Traefik straight to the containers.
      // In test mode (skipTraefik), return 404
      return this.error("Not found - requests should go through Traefik", 404)
    }

    // API routes - require authentication (except health)

    // Health check (no auth required). `version` lets clients detect agents
    // too old for the current zip layout (pre-merge agents omit it).
    if (path === "/health" && req.method === "GET") {
      return this.json({ status: "ok", version: getVersion() })
    }

    // Admin UI assets are served via the Bun.serve routes map. Any other
    // /ui/* path is a missing asset — return 404 without requiring auth.
    if (path === "/ui" || path.startsWith("/ui/")) {
      return this.error("Not found", 404)
    }

    // All other routes require auth
    const auth = this.authenticate(req)
    if (!auth) {
      return this.error("Unauthorized", 401)
    }

    // Deprecated alias kept for pre-merge CLIs: /pockets/* is /sites/*.
    if (path === "/pockets" || path.startsWith("/pockets/")) {
      path = path.replace(/^\/pockets/, "/sites")
    }

    // Scoped share-code credentials get a narrow per-site surface (download +
    // deploy their own site); everything else is 403. The god key falls through
    // to the full route table below.
    if (auth.kind === "grant") {
      return this.handleScopedRequest(auth.grant, path, req)
    }

    // GET /agent - sanitized agent settings (god key only)
    if (path === "/agent" && req.method === "GET") {
      return this.handleGetAgentInfo()
    }

    // GET /sites - list all sites
    if (path === "/sites" && req.method === "GET") {
      return this.handleListSites()
    }

    // POST /sites/:name - deploy (create-or-update) a site
    const siteMatch = path.match(/^\/sites\/([a-z0-9-]+)$/)
    if (siteMatch) {
      const siteName = siteMatch[1]!
      if (req.method === "POST") return this.handleDeploySite(siteName, req)
      if (req.method === "GET") return this.handleGetSite(siteName)
      if (req.method === "DELETE") return this.handleDeleteSite(siteName)
    }

    // GET /sites/:name/logs
    const siteLogsMatch = path.match(/^\/sites\/([a-z0-9-]+)\/logs$/)
    if (siteLogsMatch && req.method === "GET") {
      return this.handleGetSiteLogs(siteLogsMatch[1]!, url)
    }

    // GET /sites/:name/admin - reveal superuser credentials
    const siteAdminMatch = path.match(/^\/sites\/([a-z0-9-]+)\/admin$/)
    if (siteAdminMatch && req.method === "GET") {
      return this.handleGetSiteAdmin(siteAdminMatch[1]!)
    }

    // GET /sites/:name/download - download site code as zip
    const siteDownloadMatch = path.match(/^\/sites\/([a-z0-9-]+)\/download$/)
    if (siteDownloadMatch && req.method === "GET") {
      return this.handleDownloadSite(siteDownloadMatch[1]!)
    }

    // /sites/:name/thumbnail - GET the card preview image, POST to regenerate it
    const siteThumbMatch = path.match(/^\/sites\/([a-z0-9-]+)\/thumbnail$/)
    if (siteThumbMatch) {
      const thumbName = siteThumbMatch[1]!
      if (req.method === "GET") return this.handleGetSiteThumbnail(thumbName)
      if (req.method === "POST") return this.handleRefreshSiteThumbnail(thumbName)
    }

    // GET /sites/:name/history - code version history
    const siteHistoryMatch = path.match(/^\/sites\/([a-z0-9-]+)\/history$/)
    if (siteHistoryMatch && req.method === "GET") {
      return this.handleGetSiteHistory(siteHistoryMatch[1]!)
    }

    // POST /sites/:name/rollback - restore a previous code version
    const siteRollbackMatch = path.match(/^\/sites\/([a-z0-9-]+)\/rollback$/)
    if (siteRollbackMatch && req.method === "POST") {
      return this.handleRollbackSite(siteRollbackMatch[1]!, req)
    }

    // PATCH /sites/:name/domains - replace custom domains
    const siteDomainsMatch = path.match(/^\/sites\/([a-z0-9-]+)\/domains$/)
    if (siteDomainsMatch && req.method === "PATCH") {
      return this.handleUpdateSiteDomains(siteDomainsMatch[1]!, req)
    }

    // PATCH /sites/:name/rename - rename a site
    const siteRenameMatch = path.match(/^\/sites\/([a-z0-9-]+)\/rename$/)
    if (siteRenameMatch && req.method === "PATCH") {
      return this.handleRenameSite(siteRenameMatch[1]!, req)
    }

    // /sites/:name/grants - manage MCP share links for a site
    const siteGrantsMatch = path.match(/^\/sites\/([a-z0-9-]+)\/grants$/)
    if (siteGrantsMatch) {
      const siteName = siteGrantsMatch[1]!
      if (req.method === "POST") return this.handleCreateGrant(siteName, req)
      if (req.method === "GET") return this.handleListGrants(siteName)
    }

    // DELETE /sites/:name/grants/:id - revoke a share link
    const siteGrantMatch = path.match(/^\/sites\/([a-z0-9-]+)\/grants\/(grt_[a-z0-9]+)$/)
    if (siteGrantMatch && req.method === "DELETE") {
      return this.handleRevokeGrant(siteGrantMatch[1]!, siteGrantMatch[2]!)
    }

    // Apps can be disabled at the agent level (e.g. hosts that should only
    // allow sites). When off, the entire /apps/* surface is unavailable.
    // Gate on `=== false` so an unset flag (older configs, tests) means enabled.
    if (this.config.appsEnabled === false && (path === "/apps" || path.startsWith("/apps/"))) {
      return this.error("Apps are disabled on this agent", 403)
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

  // App handlers
  private async handleListApps(): Promise<Response> {
    const apps = this.appStorage.list()

    // Get TLS status from Traefik if available
    const tlsStatusMap = this.traefik ? await this.traefik.getAllRoutersTlsStatus() : new Map()

    const appInfos: AppInfo[] = apps.map((app) => scrubApp({
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
    return this.json(scrubApp(app))
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
          token?: string
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
          type: "container",
          image,
          git: body.git
            ? {
                repoUrl: body.git.repoUrl,
                branch: body.git.branch || "main",
                dockerfile: body.git.dockerfile || "Dockerfile",
                context: body.git.context,
                token: body.git.token,
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
        })

        return this.json(scrubApp(app))
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

      // Field-level merge for git so partial updates (e.g. only --git-token or
      // only --dockerfile) preserve other stored fields. Also strip clients'
      // incoming `tokenSet` — it's an output-only hint.
      if (body.git && app.git) {
        const { tokenSet: _drop, ...incoming } = body.git as typeof body.git & { tokenSet?: boolean }
        body.git = { ...app.git, ...incoming }
      }

      const updated = this.appStorage.update(name, body)
      if (!updated) {
        return this.error("Failed to update app", 500)
      }

      return this.json(scrubApp(updated))
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
          await this.git.clone(name, app.git.repoUrl, app.git.branch, app.git.token)
          const repoPath = this.git.repoPath(name)
          basePath = join(repoPath, app.compose.path)
          if (!existsSync(basePath)) {
            this.appStorage.update(name, { status: "failed" })
            return this.error(`Compose file not found at '${app.compose.path}'`, 400)
          }
        }

        // Write the override (regenerate every deploy so env/domain updates apply)
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
        await this.git.clone(name, app.git.repoUrl, app.git.branch, app.git.token)

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

  // Site handlers

  // Sanitized, read-only view of the agent's runtime settings for the admin UI.
  // Secrets (apiKey, ACME/DNS env, Cloudflare token) are deliberately omitted.
  private handleGetAgentInfo(): Response {
    const c = this.config
    return this.json({
      domain: c.domain,
      dataDir: c.dataDir,
      email: c.email ?? null,
      httpPort: c.httpPort,
      httpsPort: c.httpsPort,
      maxUploadSize: c.maxUploadSize,
      appsEnabled: c.appsEnabled !== false,
      version: getVersion(),
      siteCount: this.storage.list().length,
      appCount: this.appStorage.list().length,
    })
  }

  private async handleListSites(): Promise<Response> {
    const sites = this.storage.list()
    // Site containers register Traefik routers named `siteio-<name>` via
    // docker labels — same convention as apps.
    const tlsStatusMap = this.traefik ? await this.traefik.getAllRoutersTlsStatus() : new Map()
    return this.json(sites.map((p) => ({
      ...this.storage.toInfo(p, this.config.domain),
      tls: tlsStatusMap.get(`siteio-${p.name}`) || "pending",
      hasThumbnail: this.thumbnails?.has(p.name) ?? false,
    })))
  }

  private async handleGetSite(name: string): Promise<Response> {
    const site = this.storage.get(name)
    if (!site) return this.error("Site not found", 404)
    return this.json({
      ...this.storage.toInfo(site, this.config.domain),
      hasThumbnail: this.thumbnails?.has(name) ?? false,
    })
  }

  private async handleDeleteSite(name: string): Promise<Response> {
    const site = this.storage.get(name)
    if (!site) return this.error("Site not found", 404)
    try {
      if (this.docker.isAvailable() && this.docker.containerExists(name)) {
        await this.docker.remove(name)
      }
    } catch {
      // best effort — proceed to remove metadata/code even if the container is gone
    }
    this.storage.delete(name)
    this.thumbnails?.delete(name)
    return this.json({ deleted: true })
  }

  // Return the stored card preview (WebP). 404 when none exists — the UI falls
  // back to its placeholder.
  private handleGetSiteThumbnail(name: string): Response {
    const bytes = this.thumbnails?.read(name)
    if (!bytes) return this.error("No thumbnail", 404)
    const etag = `"${createHash("sha1").update(bytes).digest("base64url")}"`
    return new Response(bytes, {
      headers: { "Content-Type": "image/webp", "Cache-Control": "no-cache", ETag: etag },
    })
  }

  // Regenerate a site's preview on demand. Awaited (unlike the deploy-time
  // capture) so the UI knows when the fresh image is ready.
  private async handleRefreshSiteThumbnail(name: string): Promise<Response> {
    const site = this.storage.get(name)
    if (!site) return this.error("Site not found", 404)
    if (!this.thumbnails) return this.error("Thumbnails are not available", 503)
    if (!this.docker.isAvailable()) return this.error("Docker is not available", 500)
    const result = await this.thumbnails.capture(name, this.siteInternalUrl(name))
    if (!result.ok) return this.error(result.reason || "Failed to capture thumbnail", 502)
    return this.json({ generated: true })
  }

  // A site is reachable on siteio-network at its container name + PocketBase's
  // internal port. This is what the browserless container screenshots.
  private siteInternalUrl(name: string): string {
    return `http://${this.docker.containerName(name)}:8090`
  }

  // Fire-and-forget preview capture after a deploy. Never blocks or fails the
  // deploy; a short delay lets PocketBase start serving before the shot.
  private captureThumbnail(name: string): void {
    if (!this.thumbnails) return
    const thumbnails = this.thumbnails
    const url = this.siteInternalUrl(name)
    void (async () => {
      await new Promise((r) => setTimeout(r, 2000))
      await thumbnails.capture(name, url)
    })()
  }

  private async handleGetSiteAdmin(name: string): Promise<Response> {
    const site = this.storage.get(name)
    if (!site) return this.error("Site not found", 404)
    const primary = this.storage.primaryDomain(site, this.config.domain)
    return this.json({
      email: site.superuserEmail,
      password: site.superuserPassword,
      adminUrl: `https://${primary}/_/`,
    })
  }

  private async handleDownloadSite(name: string): Promise<Response> {
    if (!this.storage.exists(name)) return this.error("Site not found", 404)
    try {
      const zipData = await this.storage.zipCode(name)
      if (!zipData) return this.error("Failed to create zip", 500)
      return new Response(zipData, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${name}.zip"`,
          "Content-Length": String(zipData.length),
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to download site"
      return this.error(message, 500)
    }
  }

  private async handleGetSiteLogs(name: string, url: URL): Promise<Response> {
    if (!this.storage.exists(name)) return this.error("Site not found", 404)
    const tail = parseInt(url.searchParams.get("tail") || "100", 10)
    try {
      const logs = await this.docker.logs(name, tail)
      return this.json({ name, logs, lines: tail } as ContainerLogs)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to get logs"
      return this.error(message, 500)
    }
  }

  private async handleDeploySite(name: string, req: Request): Promise<Response> {
    // Validate upload
    const contentType = req.headers.get("Content-Type") || ""
    if (!contentType.includes("application/zip")) {
      return this.error("Expected application/zip body", 400)
    }
    const zipData = new Uint8Array(await req.arrayBuffer())
    if (zipData.length === 0) return this.error("Empty upload", 400)
    if (zipData.length > this.config.maxUploadSize) {
      return this.error("Upload too large", 413)
    }

    // Fail fast before any state mutation so a Docker outage never leaves an
    // orphaned "pending" site with extracted code but no container.
    if (!this.docker.isAvailable()) return this.error("Docker is not available", 500)

    const deployedBy = req.headers.get("X-Deployed-By") || undefined

    // Create metadata on first deploy (generates superuser creds).
    let site = this.storage.get(name)

    // Check for version conflict (optimistic concurrency control)
    const expectedVersionHeader = req.headers.get("X-Expected-Version")
    if (expectedVersionHeader !== null) {
      const expectedVersion = parseInt(expectedVersionHeader, 10)
      if (!isNaN(expectedVersion) && site?.version !== undefined && site.version !== expectedVersion) {
        return this.error(
          `Version conflict: expected v${expectedVersion} but server has v${site.version}. Someone else deployed since your last push. Use --force to override.`,
          409
        )
      }
    }

    if (!site) {
      site = this.storage.create({
        name,
        domains: [],
        pocketbaseVersion: POCKETBASE_VERSION,
        status: "pending",
        size: 0,
        superuserEmail: `admin@${name}.${this.config.domain}`,
        superuserPassword: crypto.randomUUID().replace(/-/g, ""),
      })
    }

    try {
      const info = await this.runSiteDeploy(site, zipData, deployedBy)
      return this.json(info)
    } catch (err) {
      this.storage.update(name, { status: "failed" })
      const message = err instanceof Error ? err.message : "Failed to deploy site"
      return this.error(message, 500)
    }
  }

  // Deploy core, shared by the zip-upload route and the MCP share endpoint:
  // extract merged code (archives previous version; never touches pb_data),
  // pull the pinned image, (re)create the container, and persist the new
  // version. Throws on failure — callers own status-failed bookkeeping.
  private async runSiteDeploy(
    site: Site,
    zipData: Uint8Array,
    deployedBy?: string,
    message?: string
  ): Promise<SiteInfo> {
    const { size, version: codeVersion } = await this.storage.extractCode(site.name, zipData)

    await this.docker.pull(POCKETBASE_IMAGE)
    const containerId = await this.startSiteContainer(site)

    const updated = this.storage.update(site.name, {
      status: "running",
      containerId,
      size,
      version: codeVersion,
      pocketbaseVersion: POCKETBASE_VERSION,
      deployedAt: new Date().toISOString(),
      deployedBy,
      // Always set (even to undefined) so the current version's message
      // reflects THIS deploy rather than lingering from the previous one.
      message,
    })!
    // Refresh the card preview in the background — deploy stays fast.
    this.captureThumbnail(updated.name)
    return this.storage.toInfo(updated, this.config.domain)
  }

  // Narrow surface for a scoped share-code credential: it may only download or
  // (re)deploy its own site. Anything else — other sites, apps, admin creds,
  // delete/rename/domains — is refused.
  private async handleScopedRequest(grant: ShareGrant, path: string, req: Request): Promise<Response> {
    const notAllowed = () =>
      this.error(`This share code can only download or deploy the site '${grant.site}'`, 403)

    const siteMatch = path.match(/^\/sites\/([a-z0-9-]+)$/)
    if (siteMatch) {
      if (siteMatch[1] !== grant.site) return this.error("This share code is not valid for that site", 403)
      if (req.method === "POST") return this.handleScopedDeploy(grant, req)
      if (req.method === "GET") return this.handleGetSite(grant.site)
      return notAllowed()
    }

    const downloadMatch = path.match(/^\/sites\/([a-z0-9-]+)\/download$/)
    if (downloadMatch) {
      if (downloadMatch[1] !== grant.site) return this.error("This share code is not valid for that site", 403)
      if (req.method === "GET") return this.handleDownloadSite(grant.site)
      return notAllowed()
    }

    return notAllowed()
  }

  // Deploy an invitee's uploaded code under a scoped share code. The upload is
  // merged with the site's current backend (preserved unless the grant allows
  // backend edits), then deployed via the shared core; the deploy is attributed
  // to the grant label and counts against the grant's budget.
  private async handleScopedDeploy(grant: ShareGrant, req: Request): Promise<Response> {
    const name = grant.site
    const site = this.storage.get(name)
    if (!site) return this.error("Site not found", 404)

    const contentType = req.headers.get("Content-Type") || ""
    if (!contentType.includes("application/zip")) return this.error("Expected application/zip body", 400)
    const zipData = new Uint8Array(await req.arrayBuffer())
    if (zipData.length === 0) return this.error("Empty upload", 400)
    if (zipData.length > this.config.maxUploadSize) return this.error("Upload too large", 413)
    if (!this.docker.isAvailable()) return this.error("Docker is not available", 500)

    try {
      const incoming: Record<string, Uint8Array> = {}
      for (const [k, v] of Object.entries(unzipSync(zipData))) {
        if (!k.endsWith("/")) incoming[k] = v
      }
      const merged = mergeScopedDeploy({
        incoming,
        currentCodePath: this.storage.getCodePath(name),
        allowBackend: !!grant.allowBackend,
      })
      const mergedZip = zipSync(merged, { level: 6 })
      const info = await this.runSiteDeploy(site, mergedZip, grant.label || "shared link")
      this.grants.touch(grant.id)
      return this.json(info)
    } catch (err) {
      this.storage.update(name, { status: "failed" })
      const message = err instanceof Error ? err.message : "Failed to deploy site"
      return this.error(message, 500)
    }
  }

  // Invoked by the /mcp deploy_site tool. The zip is pre-merged (invitee's web
  // root + the site's existing backend dirs), so this is a straight deploy.
  // `message` is the invitee's change description, recorded in the site history.
  private async deploySiteViaGrant(
    siteName: string,
    zipData: Uint8Array,
    deployedBy: string,
    message: string
  ): Promise<SiteInfo> {
    const site = this.storage.get(siteName)
    if (!site) throw new Error(`Site "${siteName}" no longer exists`)
    if (!this.docker.isAvailable()) throw new Error("Docker is not available")
    try {
      return await this.runSiteDeploy(site, zipData, deployedBy, message)
    } catch (err) {
      this.storage.update(siteName, { status: "failed" })
      throw err
    }
  }

  // SSRF-guarded, size-capped fetch backing the write_url MCP tool. Rejects
  // non-public targets, refuses redirects (so a public URL can't bounce to an
  // internal one), and enforces a timeout + max body size.
  private async fetchExternalAsset(url: string): Promise<Uint8Array> {
    await assertSafePublicUrl(url)
    const maxBytes = 25 * 1024 * 1024 // aligns with StagingStore's per-file cap
    let res: Response
    try {
      res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000) })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new ValidationError(`Could not fetch URL: ${msg}`)
    }
    if (!res.ok) throw new ValidationError(`Fetch failed: ${res.status} ${res.statusText}`)
    const declared = Number(res.headers.get("content-length") || "0")
    if (declared && declared > maxBytes) throw new ValidationError(`Remote file too large (max ${maxBytes} bytes)`)
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.length > maxBytes) throw new ValidationError(`Remote file too large (max ${maxBytes} bytes)`)
    return buf
  }

  // Share-grant (MCP link) handlers

  private async handleCreateGrant(name: string, req: Request): Promise<Response> {
    const site = this.storage.get(name)
    if (!site) return this.error("Site not found", 404)
    try {
      const body = (await req.json().catch(() => ({}))) as {
        allowBackend?: boolean
        label?: string
      }
      const input: CreateGrantInput = {
        site: name,
        allowBackend: body.allowBackend,
        label: body.label,
      }
      const { grant, token } = this.grants.create(input)

      // Prefer the site's own custom domain as the primary sharing host — that's
      // the site's real identity — and keep the platform subdomain as a fallback
      // (in case the custom domain's DNS/cert isn't ready yet). The CLI login
      // token points at the same primary host's scoped REST channel; either host
      // works, since the agent resolves the host to the site.
      const subdomain = `${name}.${this.config.domain}`
      const customs = this.storage.customDomains(site, this.config.domain)
      const primaryHost = customs[0] ?? subdomain
      const cliToken = encodeToken(`https://${primaryHost}/_siteio`, token)
      return this.json({
        grant: this.grants.toInfo(grant),
        url: `https://${primaryHost}/mcp`,
        code: token,
        cliToken,
        ...(primaryHost !== subdomain ? { fallbackUrl: `https://${subdomain}/mcp` } : {}),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create share link"
      return this.error(message, 400)
    }
  }

  private handleListGrants(name: string): Response {
    if (!this.storage.exists(name)) return this.error("Site not found", 404)
    return this.json(this.grants.listForSite(name).map((g) => this.grants.toInfo(g)))
  }

  private handleRevokeGrant(name: string, id: string): Response {
    const grant = this.grants.get(id)
    if (!grant || grant.site !== name) return this.error("Share link not found", 404)
    this.grants.revoke(id)
    this.staging.remove(id)
    // Kill any outstanding OAuth access tokens so live connectors stop at once.
    this.oauth.revokeTokensForGrant(id)
    return this.json({ revoked: true })
  }

  // (Re)create the site's container: remove any existing one, then run the
  // pinned image with Traefik labels for all its hostnames. Used by deploy,
  // rollback, domain updates, and rename — anything that invalidates the
  // container's bind mounts or routing labels.
  private async startSiteContainer(site: Site): Promise<string> {
    const name = site.name
    this.docker.ensureNetwork()
    if (this.docker.containerExists(name)) await this.docker.remove(name)

    const domains = this.storage.allDomains(site, this.config.domain)
    const labels = this.docker.buildTraefikLabels(name, domains, 8090)
    const containerName = this.docker.containerName(name)
    const cacheMiddleware = `${containerName}-cache`
    labels[`traefik.http.routers.${containerName}.middlewares`] = cacheMiddleware
    labels[`traefik.http.middlewares.${cacheMiddleware}.headers.customresponseheaders.Cache-Control`] =
      "no-cache, max-age=0, must-revalidate"
    labels[`traefik.http.middlewares.${cacheMiddleware}.headers.customresponseheaders.Pragma`] = "no-cache"
    labels[`traefik.http.middlewares.${cacheMiddleware}.headers.customresponseheaders.Expires`] = "0"

    const env: Record<string, string> = {
      POCKET_SUPERUSER_EMAIL: site.superuserEmail!,
      POCKET_SUPERUSER_PASSWORD: site.superuserPassword!,
    }

    // Ensure the pb_data dir exists before building the volume mount.
    mkdirSync(this.storage.getDataPath(name), { recursive: true, mode: 0o755 })

    return this.docker.run({
      name,
      image: POCKETBASE_IMAGE,
      internalPort: 8090,
      env,
      volumes: [
        { name: this.storage.getCodePath(name), mountPath: "/pb-code", readonly: true },
        { name: this.storage.getDataPath(name), mountPath: "/pb-data" },
      ],
      restartPolicy: "unless-stopped",
      network: "siteio-network",
      labels,
    })
  }

  private handleGetSiteHistory(name: string): Response {
    if (!this.storage.exists(name)) return this.error("Site not found", 404)
    return this.json(this.storage.getHistory(name))
  }

  private async handleRollbackSite(name: string, req: Request): Promise<Response> {
    const site = this.storage.get(name)
    if (!site) return this.error("Site not found", 404)

    try {
      const body = (await req.json()) as { version: number }
      if (!body.version || typeof body.version !== "number") {
        return this.error("Version number is required")
      }

      if (!this.docker.isAvailable()) return this.error("Docker is not available", 500)

      const restored = this.storage.restoreVersion(name, body.version)
      if (!restored) {
        return this.error(`Version ${body.version} not found in history`, 404)
      }

      const containerId = await this.startSiteContainer(site)
      const updated = this.storage.update(name, {
        status: "running",
        containerId,
        size: restored.size,
        version: restored.version,
        deployedAt: new Date().toISOString(),
      })!
      return this.json(this.storage.toInfo(updated, this.config.domain))
    } catch (err) {
      if (err instanceof SyntaxError) return this.error("Invalid request body")
      this.storage.update(name, { status: "failed" })
      const message = err instanceof Error ? err.message : "Failed to rollback"
      return this.error(message, 500)
    }
  }

  private async handleUpdateSiteDomains(name: string, req: Request): Promise<Response> {
    const site = this.storage.get(name)
    if (!site) return this.error("Site not found", 404)

    try {
      const body = (await req.json()) as { domains?: string[] }
      if (!body.domains || !Array.isArray(body.domains)) {
        return this.error("'domains' array is required")
      }

      const domains = body.domains.map((d) => d.toLowerCase())

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
      for (const other of this.storage.list()) {
        if (other.name === name) continue
        const overlap = domains.filter((d) => this.storage.customDomains(other, this.config.domain).includes(d))
        if (overlap.length > 0) {
          return this.error(`Domain(s) already in use by '${other.name}': ${overlap.join(", ")}`)
        }
      }

      // Check for conflicts with apps
      for (const app of this.appStorage.list()) {
        const overlap = domains.filter((d) => app.domains.includes(d))
        if (overlap.length > 0) {
          return this.error(`Domain(s) already in use by app '${app.name}': ${overlap.join(", ")}`)
        }
      }

      const updated = this.storage.update(name, { domains })!

      // Recreate the container so Traefik picks up the new host rules. A site
      // that was never deployed (no container) just keeps the metadata change.
      if (this.docker.isAvailable() && this.docker.containerExists(name)) {
        const containerId = await this.startSiteContainer(updated)
        this.storage.update(name, { containerId })
      }

      return this.json(this.storage.toInfo(this.storage.get(name)!, this.config.domain))
    } catch (err) {
      if (err instanceof SyntaxError) return this.error("Invalid request body")
      const message = err instanceof Error ? err.message : "Failed to update domains"
      return this.error(message, 500)
    }
  }

  private async handleRenameSite(name: string, req: Request): Promise<Response> {
    const site = this.storage.get(name)
    if (!site) return this.error("Site not found", 404)

    try {
      const body = (await req.json()) as { newSubdomain?: string }
      if (!body.newSubdomain || typeof body.newSubdomain !== "string") {
        return this.error("'newSubdomain' is required")
      }

      const newName = body.newSubdomain.toLowerCase()
      if (!/^[a-z0-9-]+$/.test(newName)) {
        return this.error("Name must contain only lowercase letters, numbers, and hyphens")
      }
      if (newName === "api") return this.error("'api' is a reserved name")
      if (newName === name) return this.error("New name is the same as the current one")
      if (this.storage.exists(newName)) {
        return this.error(`'${newName}' already exists`)
      }

      // The container mounts site-code/<name> and site-data/<name> — it
      // must be gone before the directories move.
      const hadContainer = this.docker.isAvailable() && this.docker.containerExists(name)
      if (hadContainer) await this.docker.remove(name)

      const renamed = this.storage.rename(name, newName)
      if (!renamed) return this.error("Failed to rename", 500)

      if (hadContainer) {
        const containerId = await this.startSiteContainer(renamed)
        this.storage.update(newName, { containerId })
      }

      // The old preview is keyed by the old name and points at the old internal
      // URL — drop it and capture a fresh one under the new name.
      this.thumbnails?.delete(name)
      if (hadContainer) this.captureThumbnail(newName)

      return this.json(this.storage.toInfo(this.storage.get(newName)!, this.config.domain))
    } catch (err) {
      if (err instanceof SyntaxError) return this.error("Invalid request body")
      const message = err instanceof Error ? err.message : "Failed to rename"
      return this.error(message, 500)
    }
  }

  // Test seam: exercise the router directly without binding a socket.
  // Sets the host header to "localhost" so the isApiRequest check passes.
  // Convert pre-merge static sites into site containers. Public so tests can
  // drive it without binding a socket via start().
  async migrateLegacy(): Promise<void> {
    if (!hasLegacySites(this.config.dataDir)) return

    console.log("> Legacy static sites detected — migrating to site containers...")
    const outcome = migrateLegacySites(this.config.dataDir, this.config.domain, this.storage, (m) => console.log(m))
    for (const s of outcome.skipped) {
      console.log(`> SKIPPED '${s.name}': ${s.reason}`)
    }
    if (outcome.migrated.length === 0) return

    if (!this.docker.isAvailable()) {
      console.log("> Docker is not available — migrated sites will start on their next deploy")
      return
    }

    // The shared nginx and oauth2-proxy containers belong to the old model.
    for (const legacy of ["nginx", "oauth2-proxy"]) {
      try {
        if (this.docker.containerExists(legacy)) await this.docker.remove(legacy)
      } catch {
        // best effort — a stale container is harmless, just unrouted
      }
    }

    try {
      await this.docker.pull(POCKETBASE_IMAGE)
    } catch (err) {
      console.log(`> Failed to pull ${POCKETBASE_IMAGE} — migrated sites will start on their next deploy`)
      return
    }

    for (const name of outcome.migrated) {
      const site = this.storage.get(name)
      if (!site) continue
      try {
        const containerId = await this.startSiteContainer(site)
        this.storage.update(name, { status: "running", containerId })
        console.log(`> Site '${name}' is running`)
      } catch (err) {
        this.storage.update(name, { status: "failed" })
        const message = err instanceof Error ? err.message : String(err)
        console.log(`> Failed to start migrated site '${name}': ${message}`)
      }
    }
  }

  // `host` defaults to "localhost" so existing api-route tests pass the api gate;
  // MCP/OAuth tests pass a real site host (e.g. "blog.example.com").
  handleRequestForTest(req: Request, host = "localhost"): Promise<Response> {
    const headers = new Headers(req.headers)
    headers.set("host", host)
    return this.handleRequest(new Request(req.url, { method: req.method, headers, body: req.body }))
  }

  async start(): Promise<void> {
    // Start Traefik (if enabled)
    if (this.traefik) {
      await this.traefik.start()
      this.traefik.updateDynamicConfig()
    }

    // One-time conversion of pre-merge shared-nginx static sites.
    await this.migrateLegacy()

    // Reclaim revoked share links (and their staging) and expired OAuth tokens.
    for (const id of this.grants.gc()) this.staging.remove(id)
    this.oauth.gc()

    const port = this.config.port || 3000

    // Admin UI assets are static text embedded in the binary. Because we serve
    // the exact bytes, we can emit a proper HTTP validator: a content-hash
    // ETag plus `Cache-Control: no-cache` (store, but revalidate before reuse).
    // Caches/browsers revalidate with `If-None-Match`; unchanged assets get a
    // cheap `304 Not Modified`, and a new release changes the hash so the old
    // copy is invalidated automatically — no stale asset, no manual purge, no
    // URL versioning. This is why the same URL can safely be cached.
    const etagFor = (body: string) => `"${createHash("sha1").update(body).digest("base64url")}"`
    const serveUiAsset = (req: Request, body: string, contentType: string, etag: string): Response => {
      const headers: Record<string, string> = {
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
        ETag: etag,
      }
      if (req.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers })
      }
      return new Response(body, { headers })
    }
    const htmlEtag = etagFor(ADMIN_UI_HTML)
    const jsEtag = etagFor(ADMIN_UI_JS)
    const cssEtag = etagFor(ADMIN_UI_CSS)

    // Start HTTP server
    this.server = Bun.serve({
      port,
      routes: {
        "/ui": (req) => serveUiAsset(req, ADMIN_UI_HTML, "text/html; charset=utf-8", htmlEtag),
        "/ui/ui.js": (req) => serveUiAsset(req, ADMIN_UI_JS, "application/javascript; charset=utf-8", jsEtag),
        "/ui/ui.css": (req) => serveUiAsset(req, ADMIN_UI_CSS, "text/css; charset=utf-8", cssEtag),
      },
      fetch: (req) => this.handleRequest(req),
    })

    // Download the site-preview browser image in the background so the first
    // capture (deploy or manual refresh) doesn't stall on a ~3GB pull — which,
    // behind a CDN request timeout, would otherwise never complete in time.
    this.thumbnails?.prewarm()

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
    this.thumbnails?.stop()
    if (this.server) {
      this.server.stop()
      this.server = null
    }
  }
}
