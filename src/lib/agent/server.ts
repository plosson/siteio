import type { AgentConfig, ApiResponse, SiteInfo } from "../../types.ts"
import { SiteStorage } from "./storage.ts"
import { TraefikManager } from "./traefik.ts"
import { createFileServerHandler } from "./fileserver.ts"

export class AgentServer {
  private config: AgentConfig
  private storage: SiteStorage
  private traefik: TraefikManager | null = null
  private server: ReturnType<typeof Bun.serve> | null = null
  private fileServerHandler: (req: Request) => Promise<Response | null>

  constructor(config: AgentConfig) {
    this.config = config
    this.storage = new SiteStorage(config.dataDir)
    if (!config.skipTraefik) {
      this.traefik = new TraefikManager({
        dataDir: config.dataDir,
        domain: config.domain,
        email: config.email,
        httpPort: config.httpPort,
        httpsPort: config.httpsPort,
        fileServerPort: config.port || 3000,
      })
    }
    this.fileServerHandler = createFileServerHandler(this.storage, config.domain)
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
    const host = req.headers.get("host") || ""
    const hostWithoutPort = host.split(":")[0]

    // Check if this is an API request (api.domain)
    const isApiRequest = hostWithoutPort === `api.${this.config.domain}` ||
      hostWithoutPort === "localhost" ||
      hostWithoutPort === "127.0.0.1"

    if (!isApiRequest) {
      // Try to serve static files
      const fileResponse = await this.fileServerHandler(req)
      if (fileResponse) {
        return fileResponse
      }
      return this.error("Not found", 404)
    }

    // API routes - require authentication (except health)
    const path = url.pathname

    // Health check (no auth required)
    if (path === "/health" && req.method === "GET") {
      return this.json({ status: "ok" })
    }

    // All other routes require auth
    if (!this.checkAuth(req)) {
      return this.error("Unauthorized", 401)
    }

    // GET /sites - list all sites
    if (path === "/sites" && req.method === "GET") {
      return this.handleListSites()
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

    return this.error("Not found", 404)
  }

  private handleListSites(): Response {
    const sites = this.storage.listSites()
    const siteInfos: SiteInfo[] = sites.map((site) => ({
      subdomain: site.subdomain,
      url: `https://${site.subdomain}.${this.config.domain}`,
      size: site.size,
      deployedAt: site.deployedAt,
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

      // Extract and store
      const metadata = await this.storage.extractAndStore(subdomain, zipData)

      // Update Traefik config
      const allSites = this.storage.listSites()
      this.traefik?.updateDynamicConfig(allSites.map((s) => s.subdomain))

      const siteInfo: SiteInfo = {
        subdomain: metadata.subdomain,
        url: `https://${metadata.subdomain}.${this.config.domain}`,
        size: metadata.size,
        deployedAt: metadata.deployedAt,
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

    const deleted = this.storage.deleteSite(subdomain)
    if (!deleted) {
      return this.error("Failed to delete site", 500)
    }

    // Update Traefik config
    const allSites = this.storage.listSites()
    this.traefik?.updateDynamicConfig(allSites.map((s) => s.subdomain))

    return this.json(null)
  }

  async start(): Promise<void> {
    // Start Traefik (if enabled)
    if (this.traefik) {
      await this.traefik.start()
      const existingSites = this.storage.listSites()
      this.traefik.updateDynamicConfig(existingSites.map((s) => s.subdomain))
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
