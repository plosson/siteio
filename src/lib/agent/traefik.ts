import { existsSync, writeFileSync, mkdirSync, readFileSync } from "fs"
import { join } from "path"
import { spawn, spawnSync } from "bun"
import { connect as tlsConnect, type PeerCertificate } from "tls"
import type { SiteMetadata, AgentOAuthConfig } from "../../types.ts"

const TRAEFIK_CONTAINER_NAME = "siteio-traefik"
const NGINX_CONTAINER_NAME = "siteio-nginx"
const OAUTH_PROXY_CONTAINER_NAME = "siteio-oauth2-proxy"
const TRAEFIK_IMAGE = "traefik:v3.0"
const NGINX_IMAGE = "nginx:alpine"
const OAUTH_PROXY_IMAGE = "quay.io/oauth2-proxy/oauth2-proxy:v7.6.0"

export interface TraefikConfig {
  dataDir: string
  domain: string
  email?: string
  httpPort: number
  httpsPort: number
  fileServerPort: number
  oauthConfig?: AgentOAuthConfig
}

export class TraefikManager {
  private config: TraefikConfig
  private configDir: string
  private dynamicConfigPath: string
  private staticConfigPath: string
  private certsDir: string
  private nginxConfigDir: string
  private sitesDir: string
  private oauthProxyPort = 4180

  constructor(config: TraefikConfig) {
    this.config = config
    this.configDir = join(config.dataDir, "traefik")
    this.dynamicConfigPath = join(this.configDir, "dynamic.yml")
    this.staticConfigPath = join(this.configDir, "traefik.yml")
    this.certsDir = join(config.dataDir, "certs")
    this.nginxConfigDir = join(config.dataDir, "nginx")
    this.sitesDir = join(config.dataDir, "sites")

    // Ensure directories exist
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true })
    }
    if (!existsSync(this.certsDir)) {
      mkdirSync(this.certsDir, { recursive: true })
    }
    if (!existsSync(this.nginxConfigDir)) {
      mkdirSync(this.nginxConfigDir, { recursive: true })
    }
    if (!existsSync(this.sitesDir)) {
      mkdirSync(this.sitesDir, { recursive: true })
    }

    // Ensure acme.json exists with correct permissions
    const acmePath = join(this.certsDir, "acme.json")
    if (!existsSync(acmePath)) {
      writeFileSync(acmePath, "{}")
      // Set permissions to 600 (required by Traefik)
      spawnSync({ cmd: ["chmod", "600", acmePath] })
    }

    // Write nginx config for subdomain-based routing
    this.writeNginxConfig()
  }

  /**
   * Generate nginx config that routes based on subdomain.
   * Uses a regex to extract subdomain from Host header and serve from /sites/<subdomain>/
   */
  private generateNginxConfig(): string {
    const { domain } = this.config
    // Escape dots in domain for regex
    const escapedDomain = domain.replace(/\./g, "\\.")

    return `
server {
    listen 80;
    server_name ~^(?<subdomain>[a-z0-9-]+)\\.${escapedDomain}$;

    root /sites/$subdomain;
    index index.html index.htm;

    # Handle SPA routing - try file, then directory, then fall back to index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
}

# Default server for unmatched hosts
server {
    listen 80 default_server;
    return 404;
}
`.trim()
  }

  private writeNginxConfig(): void {
    const configPath = join(this.nginxConfigDir, "default.conf")
    writeFileSync(configPath, this.generateNginxConfig())
  }

  async startNginx(): Promise<void> {
    // Remove existing container if it exists
    if (this.containerExists(NGINX_CONTAINER_NAME)) {
      console.log("> Removing existing nginx container...")
      this.removeContainer(NGINX_CONTAINER_NAME)
    }

    // Ensure nginx config is up to date
    this.writeNginxConfig()

    const args = [
      "docker",
      "run",
      "-d",
      "--name",
      NGINX_CONTAINER_NAME,
      "--restart",
      "unless-stopped",
      "--network",
      "siteio-network",
      // Mount sites directory
      "-v",
      `${this.sitesDir}:/sites:ro`,
      // Mount nginx config
      "-v",
      `${this.nginxConfigDir}/default.conf:/etc/nginx/conf.d/default.conf:ro`,
      // Traefik labels for service discovery
      "-l",
      "traefik.enable=true",
      NGINX_IMAGE,
    ]

    const result = spawnSync({ cmd: args, stdout: "pipe", stderr: "pipe" })

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString()
      throw new Error(`Failed to start nginx container: ${stderr}`)
    }

    const containerId = result.stdout.toString().trim().slice(0, 12)
    console.log(`> nginx container started: ${containerId}`)

    // Wait and verify it's running
    await new Promise((resolve) => setTimeout(resolve, 1000))

    if (!this.isContainerRunning(NGINX_CONTAINER_NAME)) {
      const logs = spawnSync({
        cmd: ["docker", "logs", NGINX_CONTAINER_NAME],
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = logs.stdout.toString() + logs.stderr.toString()
      throw new Error(`nginx container failed to start. Logs:\n${output}`)
    }
  }

  stopNginx(): void {
    if (this.containerExists(NGINX_CONTAINER_NAME)) {
      console.log("> Stopping nginx container...")
      spawnSync({ cmd: ["docker", "stop", NGINX_CONTAINER_NAME], stdout: "pipe", stderr: "pipe" })
      spawnSync({ cmd: ["docker", "rm", NGINX_CONTAINER_NAME], stdout: "pipe", stderr: "pipe" })
    }
  }

  hasOAuthConfig(): boolean {
    return !!this.config.oauthConfig
  }

  updateOAuthConfig(oauthConfig: AgentOAuthConfig): void {
    this.config.oauthConfig = oauthConfig
  }

  generateStaticConfig(): string {
    const { httpPort, httpsPort, email } = this.config

    // Paths are relative to container mount points
    return `
api:
  dashboard: false
  insecure: true

entryPoints:
  web:
    address: ":${httpPort}"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
  websecure:
    address: ":${httpsPort}"

providers:
  file:
    filename: /etc/traefik/dynamic.yml
    watch: true
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false
    network: siteio-network

certificatesResolvers:
  letsencrypt:
    acme:
      email: ${email || "admin@example.com"}
      storage: /certs/acme.json
      httpChallenge:
        entryPoint: web

log:
  level: INFO
`.trim()
  }

  generateDynamicConfig(sites: SiteMetadata[]): string {
    const { domain, fileServerPort, oauthConfig } = this.config
    const routers: Record<string, unknown> = {}
    const services: Record<string, unknown> = {}
    const middlewares: Record<string, unknown> = {}

    // Use host.docker.internal to reach the host from container
    const hostUrl = `http://host.docker.internal:${fileServerPort}`

    // Add OAuth middlewares and service if OAuth is configured on the server
    if (oauthConfig) {
      // oauth2-proxy service for handling OAuth flow
      services["oauth2-proxy-service"] = {
        loadBalancer: {
          servers: [{ url: `http://${OAUTH_PROXY_CONTAINER_NAME}:4180` }],
        },
      }

      // oauth2-auth: forwardAuth to oauth2-proxy for authentication
      // oauth2-proxy returns 202 with X-Auth-Request-Email if authenticated,
      // or 401 with redirect to start OAuth flow if not
      middlewares["oauth2-auth"] = {
        forwardAuth: {
          address: `http://${OAUTH_PROXY_CONTAINER_NAME}:4180/oauth2/auth`,
          authResponseHeaders: ["X-Auth-Request-User", "X-Auth-Request-Email"],
        },
      }

      // siteio-auth: forwardAuth to siteio agent for authorization
      // Checks if the authenticated email is allowed to access this resource
      middlewares["siteio-auth"] = {
        forwardAuth: {
          address: `${hostUrl}/auth/check`,
          authRequestHeaders: ["X-Auth-Request-Email", "Host"],
        },
      }

      // oauth2-errors: Redirect 401 responses to the OAuth sign-in page
      // When oauth2-auth returns 401, this redirects to start the OAuth flow
      middlewares["oauth2-errors"] = {
        errors: {
          status: ["401"],
          service: "oauth2-proxy-service",
          query: "/oauth2/sign_in?rd={url}",
        },
      }

      // Catch-all router for /oauth2/* paths on any subdomain
      // This handles OAuth callbacks and start URLs without auth middleware
      routers["oauth2-catchall"] = {
        rule: `HostRegexp(\`{subdomain:[a-z0-9-]+}.${domain}\`) && PathPrefix(\`/oauth2/\`)`,
        entryPoints: ["websecure"],
        service: "oauth2-proxy-service",
        priority: 200, // High priority to match before site/app routers
        tls: {
          certResolver: "letsencrypt",
        },
      }
    }

    // Add API router (reserved subdomain)
    routers["api-router"] = {
      rule: `Host(\`api.${domain}\`)`,
      entryPoints: ["websecure"],
      service: "api-service",
      tls: {
        certResolver: "letsencrypt",
      },
    }

    services["api-service"] = {
      loadBalancer: {
        servers: [{ url: hostUrl }],
      },
    }

    // Add shared nginx service for all static sites
    services["nginx-service"] = {
      loadBalancer: {
        servers: [{ url: `http://${NGINX_CONTAINER_NAME}:80` }],
      },
    }

    // Add a router for each static site
    for (const site of sites) {
      const routerName = `site-${site.subdomain}`
      const router: Record<string, unknown> = {
        rule: `Host(\`${site.subdomain}.${domain}\`)`,
        entryPoints: ["websecure"],
        service: "nginx-service",
        tls: {
          certResolver: "letsencrypt",
        },
      }

      // Apply OAuth middlewares if site has OAuth configured
      // Chain: oauth2-errors (redirect 401) -> oauth2-auth (authenticate) -> siteio-auth (authorize)
      // Note: /oauth2/* paths are handled by the oauth2-catchall router
      if (site.oauth && oauthConfig) {
        router.middlewares = ["oauth2-errors", "oauth2-auth", "siteio-auth"]
      }

      routers[routerName] = router
    }

    const config: Record<string, unknown> = {
      http: {
        routers,
        services,
      },
    }

    // Only add middlewares section if there are any
    if (Object.keys(middlewares).length > 0) {
      ;(config.http as Record<string, unknown>).middlewares = middlewares
    }

    return this.toYaml(config)
  }

  private toYaml(obj: unknown, indent = 0): string {
    const spaces = "  ".repeat(indent)
    let result = ""

    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (typeof item === "object" && item !== null) {
          // Inline the first key-value on the same line as the dash
          const entries = Object.entries(item)
          if (entries.length > 0) {
            const [firstKey, firstValue] = entries[0]!
            if (typeof firstValue === "object" && firstValue !== null) {
              result += `${spaces}- ${firstKey}:\n${this.toYaml(firstValue, indent + 2)}`
            } else {
              result += `${spaces}- ${firstKey}: ${JSON.stringify(firstValue)}\n`
            }
            // Add remaining entries
            for (let i = 1; i < entries.length; i++) {
              const [key, value] = entries[i]!
              if (typeof value === "object" && value !== null) {
                result += `${spaces}  ${key}:\n${this.toYaml(value, indent + 2)}`
              } else {
                result += `${spaces}  ${key}: ${JSON.stringify(value)}\n`
              }
            }
          }
        } else {
          result += `${spaces}- ${item}\n`
        }
      }
    } else if (typeof obj === "object" && obj !== null) {
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === "object" && value !== null) {
          result += `${spaces}${key}:\n${this.toYaml(value, indent + 1)}`
        } else {
          result += `${spaces}${key}: ${JSON.stringify(value)}\n`
        }
      }
    }

    return result
  }

  writeStaticConfig(): void {
    writeFileSync(this.staticConfigPath, this.generateStaticConfig())
  }

  updateDynamicConfig(sites: SiteMetadata[]): void {
    writeFileSync(this.dynamicConfigPath, this.generateDynamicConfig(sites))
  }

  private isDockerAvailable(): boolean {
    const result = spawnSync({ cmd: ["docker", "info"], stdout: "pipe", stderr: "pipe" })
    return result.exitCode === 0
  }

  private isContainerRunning(containerName: string): boolean {
    const result = spawnSync({
      cmd: ["docker", "inspect", "-f", "{{.State.Running}}", containerName],
      stdout: "pipe",
      stderr: "pipe",
    })
    return result.exitCode === 0 && result.stdout.toString().trim() === "true"
  }

  private containerExists(containerName: string): boolean {
    const result = spawnSync({
      cmd: ["docker", "inspect", containerName],
      stdout: "pipe",
      stderr: "pipe",
    })
    return result.exitCode === 0
  }

  private removeContainer(containerName: string): void {
    spawnSync({ cmd: ["docker", "rm", "-f", containerName], stdout: "pipe", stderr: "pipe" })
  }

  private ensureNetwork(networkName: string = "siteio-network"): void {
    // Check if network exists
    const inspect = spawnSync({
      cmd: ["docker", "network", "inspect", networkName],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (inspect.exitCode !== 0) {
      // Create network
      const create = spawnSync({
        cmd: ["docker", "network", "create", networkName],
        stdout: "pipe",
        stderr: "pipe",
      })

      if (create.exitCode !== 0) {
        throw new Error(`Failed to create Docker network: ${create.stderr.toString()}`)
      }
      console.log(`> Created Docker network: ${networkName}`)
    }
  }

  async startOAuthProxy(): Promise<void> {
    const { oauthConfig, domain } = this.config

    if (!oauthConfig) {
      return
    }

    // Remove existing container if it exists
    if (this.containerExists(OAUTH_PROXY_CONTAINER_NAME)) {
      console.log("> Removing existing oauth2-proxy container...")
      this.removeContainer(OAUTH_PROXY_CONTAINER_NAME)
    }

    // oauth2-proxy configuration for OIDC provider
    // Using reverse proxy mode: oauth2-proxy handles auth and proxies to fileserver
    const { fileServerPort } = this.config
    const upstreamUrl = `http://host.docker.internal:${fileServerPort}`

    const args = [
      "docker",
      "run",
      "-d",
      "--name",
      OAUTH_PROXY_CONTAINER_NAME,
      "--restart",
      "unless-stopped",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-p",
      `${this.oauthProxyPort}:4180`,
      // Environment variables for oauth2-proxy
      // Ensure issuer URL has trailing slash (required by OIDC spec, enforced by oauth2-proxy)
      "-e",
      "OAUTH2_PROXY_PROVIDER=oidc",
      "-e",
      `OAUTH2_PROXY_OIDC_ISSUER_URL=${oauthConfig.issuerUrl.endsWith("/") ? oauthConfig.issuerUrl : oauthConfig.issuerUrl + "/"}`,
      "-e",
      `OAUTH2_PROXY_CLIENT_ID=${oauthConfig.clientId}`,
      "-e",
      `OAUTH2_PROXY_CLIENT_SECRET=${oauthConfig.clientSecret}`,
      "-e",
      `OAUTH2_PROXY_COOKIE_SECRET=${oauthConfig.cookieSecret}`,
      "-e",
      `OAUTH2_PROXY_COOKIE_DOMAINS=.${oauthConfig.cookieDomain}`,
      "-e",
      "OAUTH2_PROXY_EMAIL_DOMAINS=*",
      "-e",
      "OAUTH2_PROXY_COOKIE_SECURE=true",
      "-e",
      "OAUTH2_PROXY_REVERSE_PROXY=true",
      "-e",
      "OAUTH2_PROXY_SET_XAUTHREQUEST=true",
      "-e",
      "OAUTH2_PROXY_PASS_ACCESS_TOKEN=true",
      "-e",
      "OAUTH2_PROXY_PASS_USER_HEADERS=true",
      "-e",
      `OAUTH2_PROXY_WHITELIST_DOMAINS=.${domain}`,
      "-e",
      "OAUTH2_PROXY_HTTP_ADDRESS=0.0.0.0:4180",
      // Don't set REDIRECT_URL - let oauth2-proxy auto-generate from request host
      // This allows callbacks to come to the same subdomain that initiated the flow
      "-e",
      "OAUTH2_PROXY_SKIP_PROVIDER_BUTTON=true",
      "-e",
      `OAUTH2_PROXY_UPSTREAMS=${upstreamUrl}`,
      // Allow unverified emails (some OIDC providers don't verify emails by default)
      "-e",
      "OAUTH2_PROXY_INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL=true",
      OAUTH_PROXY_IMAGE,
    ]

    const result = spawnSync({ cmd: args, stdout: "pipe", stderr: "pipe" })

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString()
      throw new Error(`Failed to start oauth2-proxy container: ${stderr}`)
    }

    const containerId = result.stdout.toString().trim().slice(0, 12)
    console.log(`> oauth2-proxy container started: ${containerId}`)

    // Wait a moment and verify it's running
    await new Promise((resolve) => setTimeout(resolve, 1000))

    if (!this.isContainerRunning(OAUTH_PROXY_CONTAINER_NAME)) {
      const logs = spawnSync({
        cmd: ["docker", "logs", OAUTH_PROXY_CONTAINER_NAME],
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = logs.stdout.toString() + logs.stderr.toString()
      throw new Error(`oauth2-proxy container failed to start. Logs:\n${output}`)
    }
  }

  stopOAuthProxy(): void {
    if (this.containerExists(OAUTH_PROXY_CONTAINER_NAME)) {
      console.log("> Stopping oauth2-proxy container...")
      spawnSync({ cmd: ["docker", "stop", OAUTH_PROXY_CONTAINER_NAME], stdout: "pipe", stderr: "pipe" })
      spawnSync({ cmd: ["docker", "rm", OAUTH_PROXY_CONTAINER_NAME], stdout: "pipe", stderr: "pipe" })
    }
  }

  async restartOAuthProxy(): Promise<void> {
    this.stopOAuthProxy()
    await this.startOAuthProxy()
  }

  async start(): Promise<void> {
    // Check Docker is available
    if (!this.isDockerAvailable()) {
      throw new Error("Docker is not available. Please install Docker to run siteio agent.")
    }

    // Write initial configs
    this.writeStaticConfig()
    this.updateDynamicConfig([])

    // Ensure Docker network exists
    this.ensureNetwork()

    // Remove existing container if it exists
    if (this.containerExists(TRAEFIK_CONTAINER_NAME)) {
      console.log("> Removing existing Traefik container...")
      this.removeContainer(TRAEFIK_CONTAINER_NAME)
    }

    const { httpPort, httpsPort } = this.config

    // Start Traefik container
    const args = [
      "docker",
      "run",
      "-d",
      "--name",
      TRAEFIK_CONTAINER_NAME,
      "--restart",
      "unless-stopped",
      // Connect to siteio-network to communicate with app containers
      "--network",
      "siteio-network",
      // Add host.docker.internal support on Linux
      "--add-host",
      "host.docker.internal:host-gateway",
      // Port mappings
      "-p",
      `${httpPort}:${httpPort}`,
      "-p",
      `${httpsPort}:${httpsPort}`,
      // Traefik API port (localhost only for internal access)
      "-p",
      "127.0.0.1:8080:8080",
      // Mount Docker socket for container discovery
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock:ro",
      // Mount config directory
      "-v",
      `${this.configDir}:/etc/traefik:ro`,
      // Mount certs directory (needs write access for acme.json)
      "-v",
      `${this.certsDir}:/certs`,
      // Traefik image
      TRAEFIK_IMAGE,
      // Config file path inside container
      "--configFile=/etc/traefik/traefik.yml",
    ]

    const result = spawnSync({ cmd: args, stdout: "pipe", stderr: "pipe" })

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString()
      throw new Error(`Failed to start Traefik container: ${stderr}`)
    }

    const containerId = result.stdout.toString().trim().slice(0, 12)
    console.log(`> Traefik container started: ${containerId}`)

    // Wait a moment and verify it's running
    await new Promise((resolve) => setTimeout(resolve, 1000))

    if (!this.isContainerRunning(TRAEFIK_CONTAINER_NAME)) {
      // Get logs for debugging
      const logs = spawnSync({
        cmd: ["docker", "logs", TRAEFIK_CONTAINER_NAME],
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = logs.stdout.toString() + logs.stderr.toString()
      throw new Error(`Traefik container failed to start. Logs:\n${output}`)
    }

    // Start shared nginx container for static sites
    await this.startNginx()

    // Start oauth2-proxy if OAuth is configured
    if (this.config.oauthConfig) {
      await this.startOAuthProxy()
    }
  }

  // Query Traefik API to get TLS status for a router
  async getRouterTlsStatus(routerName: string): Promise<"valid" | "pending" | "error" | "none"> {
    try {
      const response = await fetch(`http://127.0.0.1:8080/api/http/routers/${routerName}@file`)
      if (!response.ok) {
        return "pending" // Router not found yet
      }
      const router = (await response.json()) as {
        tls?: { certResolver?: string }
        status?: string
      }

      if (!router.tls) {
        return "none" // No TLS configured
      }

      // Check if router status indicates an error
      if (router.status === "disabled") {
        return "error"
      }

      return "valid"
    } catch {
      return "pending" // API not available or error
    }
  }

  // Verify actual certificate being served by making TLS connection
  private verifyActualCert(domain: string): Promise<"valid" | "pending" | "error"> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        socket.destroy()
        resolve("error")
      }, 5000)

      const socket = tlsConnect(
        443,
        domain,
        {
          servername: domain,
          rejectUnauthorized: false, // Allow self-signed to get cert info
        },
        () => {
          clearTimeout(timeout)
          const cert = socket.getPeerCertificate() as PeerCertificate & { issuer?: { O?: string } }
          socket.end()

          // Check if issuer is Let's Encrypt
          if (cert?.issuer?.O === "Let's Encrypt") {
            resolve("valid")
          } else {
            // Still serving default/self-signed cert
            resolve("pending")
          }
        }
      )

      socket.on("error", () => {
        clearTimeout(timeout)
        resolve("error")
      })
    })
  }

  // Get TLS status for all routers
  async getAllRoutersTlsStatus(): Promise<Map<string, "valid" | "pending" | "error" | "none">> {
    const statusMap = new Map<string, "valid" | "pending" | "error" | "none">()

    try {
      const response = await fetch("http://127.0.0.1:8080/api/http/routers")
      if (!response.ok) {
        return statusMap
      }
      const routers = (await response.json()) as Array<{
        name: string
        rule: string
        tls?: { certResolver?: string }
        status?: string
      }>

      // Collect domains to verify in parallel
      const domainsToVerify: Array<{ baseName: string; domain: string }> = []

      for (const router of routers) {
        // Extract the base name (e.g., "site-mysite@file" -> "site-mysite")
        const baseName = router.name.split("@")[0] || router.name

        if (!router.tls) {
          statusMap.set(baseName, "none")
        } else if (router.status === "disabled") {
          statusMap.set(baseName, "error")
        } else {
          // Extract domain from rule (e.g., "Host(`example.com`)" -> "example.com")
          const domainMatch = router.rule.match(/Host\(`([^`]+)`\)/)
          const domain = domainMatch?.[1]

          if (domain && domain.includes(".")) {
            // Valid domain - queue for verification
            domainsToVerify.push({ baseName, domain })
          } else {
            // Invalid domain (e.g., "siteio-nginx-demo" without dots)
            statusMap.set(baseName, "error")
          }
        }
      }

      // Verify actual certs in parallel
      if (domainsToVerify.length > 0) {
        const results = await Promise.all(
          domainsToVerify.map(async ({ baseName, domain }) => {
            const status = await this.verifyActualCert(domain)
            return { baseName, status }
          })
        )

        for (const { baseName, status } of results) {
          statusMap.set(baseName, status)
        }
      }
    } catch {
      // API not available
    }

    return statusMap
  }

  stop(): void {
    // Stop oauth2-proxy first
    this.stopOAuthProxy()

    // Stop nginx
    this.stopNginx()

    if (this.containerExists(TRAEFIK_CONTAINER_NAME)) {
      console.log("> Stopping Traefik container...")
      spawnSync({ cmd: ["docker", "stop", TRAEFIK_CONTAINER_NAME], stdout: "pipe", stderr: "pipe" })
      spawnSync({ cmd: ["docker", "rm", TRAEFIK_CONTAINER_NAME], stdout: "pipe", stderr: "pipe" })
    }
  }
}
