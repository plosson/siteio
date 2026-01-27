import { existsSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { spawn, spawnSync } from "bun"
import type { SiteMetadata, AgentOAuthConfig } from "../../types.ts"

const TRAEFIK_CONTAINER_NAME = "siteio-traefik"
const OAUTH_PROXY_CONTAINER_NAME = "siteio-oauth2-proxy"
const TRAEFIK_IMAGE = "traefik:v3.0"
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
  private oauthProxyPort = 4180

  constructor(config: TraefikConfig) {
    this.config = config
    this.configDir = join(config.dataDir, "traefik")
    this.dynamicConfigPath = join(this.configDir, "dynamic.yml")
    this.staticConfigPath = join(this.configDir, "traefik.yml")
    this.certsDir = join(config.dataDir, "certs")

    // Ensure directories exist
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true })
    }
    if (!existsSync(this.certsDir)) {
      mkdirSync(this.certsDir, { recursive: true })
    }

    // Ensure acme.json exists with correct permissions
    const acmePath = join(this.certsDir, "acme.json")
    if (!existsSync(acmePath)) {
      writeFileSync(acmePath, "{}")
      // Set permissions to 600 (required by Traefik)
      spawnSync({ cmd: ["chmod", "600", acmePath] })
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
  insecure: false

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
    const oauthProxyUrl = `http://host.docker.internal:${this.oauthProxyPort}`

    // Check if we have protected sites
    const hasProtectedSites = oauthConfig && sites.some((site) => site.oauth)

    // Add oauth2-proxy service if OAuth is configured
    if (hasProtectedSites) {
      services["oauth2-proxy-service"] = {
        loadBalancer: {
          servers: [{ url: oauthProxyUrl }],
        },
      }

      // Add router for /oauth2/* paths on API domain (for callback, sign_in, etc.)
      // This needs higher priority than the general api-router
      routers["oauth2-router"] = {
        rule: `Host(\`api.${domain}\`) && PathPrefix(\`/oauth2/\`)`,
        entryPoints: ["websecure"],
        service: "oauth2-proxy-service",
        priority: 100,
        tls: {
          certResolver: "letsencrypt",
        },
      }
    }

    // Add router and service for each site
    for (const site of sites) {
      const { subdomain, oauth } = site
      const routerName = `${subdomain}-router`
      const serviceName = `${subdomain}-service`

      // Protected sites route through oauth2-proxy (which proxies to fileserver)
      // Unprotected sites route directly to fileserver
      const useOAuthProxy = oauth && oauthConfig

      const router: Record<string, unknown> = {
        rule: `Host(\`${subdomain}.${domain}\`)`,
        entryPoints: ["websecure"],
        service: useOAuthProxy ? "oauth2-proxy-service" : serviceName,
        tls: {
          certResolver: "letsencrypt",
        },
      }

      routers[routerName] = router

      // Only create dedicated service for unprotected sites
      // Protected sites use the shared oauth2-proxy-service
      if (!useOAuthProxy) {
        services[serviceName] = {
          loadBalancer: {
            servers: [{ url: hostUrl }],
          },
        }
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

    // oauth2-proxy configuration for Clerk as OIDC provider
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
      "-e",
      "OAUTH2_PROXY_PROVIDER=oidc",
      "-e",
      `OAUTH2_PROXY_OIDC_ISSUER_URL=${oauthConfig.clerkIssuerUrl}`,
      "-e",
      `OAUTH2_PROXY_CLIENT_ID=${oauthConfig.clerkClientId}`,
      "-e",
      `OAUTH2_PROXY_CLIENT_SECRET=${oauthConfig.clerkClientSecret}`,
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
      `OAUTH2_PROXY_WHITELIST_DOMAINS=.${domain}`,
      "-e",
      "OAUTH2_PROXY_HTTP_ADDRESS=0.0.0.0:4180",
      "-e",
      `OAUTH2_PROXY_REDIRECT_URL=https://api.${domain}/oauth2/callback`,
      "-e",
      "OAUTH2_PROXY_SKIP_PROVIDER_BUTTON=true",
      "-e",
      `OAUTH2_PROXY_UPSTREAMS=${upstreamUrl}`,
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
      // Add host.docker.internal support on Linux
      "--add-host",
      "host.docker.internal:host-gateway",
      // Port mappings
      "-p",
      `${httpPort}:${httpPort}`,
      "-p",
      `${httpsPort}:${httpsPort}`,
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

    // Start oauth2-proxy if OAuth is configured
    if (this.config.oauthConfig) {
      await this.startOAuthProxy()
    }
  }

  stop(): void {
    // Stop oauth2-proxy first
    this.stopOAuthProxy()

    if (this.containerExists(TRAEFIK_CONTAINER_NAME)) {
      console.log("> Stopping Traefik container...")
      spawnSync({ cmd: ["docker", "stop", TRAEFIK_CONTAINER_NAME], stdout: "pipe", stderr: "pipe" })
      spawnSync({ cmd: ["docker", "rm", TRAEFIK_CONTAINER_NAME], stdout: "pipe", stderr: "pipe" })
    }
  }
}
