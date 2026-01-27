import { existsSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { spawn, type Subprocess } from "bun"

export interface TraefikConfig {
  dataDir: string
  domain: string
  email?: string
  httpPort: number
  httpsPort: number
  fileServerPort: number
}

export class TraefikManager {
  private config: TraefikConfig
  private configDir: string
  private dynamicConfigPath: string
  private staticConfigPath: string
  private certsDir: string
  private process: Subprocess | null = null

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
  }

  generateStaticConfig(): string {
    const { httpPort, httpsPort, email } = this.config

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
    filename: ${this.dynamicConfigPath}
    watch: true

certificatesResolvers:
  letsencrypt:
    acme:
      email: ${email || "admin@example.com"}
      storage: ${join(this.certsDir, "acme.json")}
      httpChallenge:
        entryPoint: web

log:
  level: INFO
`.trim()
  }

  generateDynamicConfig(subdomains: string[]): string {
    const { domain, fileServerPort } = this.config
    const routers: Record<string, unknown> = {}
    const services: Record<string, unknown> = {}

    // Add router and service for each subdomain
    for (const subdomain of subdomains) {
      const routerName = `${subdomain}-router`
      const serviceName = `${subdomain}-service`

      routers[routerName] = {
        rule: `Host(\`${subdomain}.${domain}\`)`,
        entryPoints: ["websecure"],
        service: serviceName,
        tls: {
          certResolver: "letsencrypt",
        },
      }

      services[serviceName] = {
        loadBalancer: {
          servers: [{ url: `http://127.0.0.1:${fileServerPort}` }],
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
        servers: [{ url: `http://127.0.0.1:${fileServerPort}` }],
      },
    }

    const config = {
      http: {
        routers,
        services,
      },
    }

    return this.toYaml(config)
  }

  private toYaml(obj: unknown, indent = 0): string {
    const spaces = "  ".repeat(indent)
    let result = ""

    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (typeof item === "object" && item !== null) {
          result += `${spaces}-\n${this.toYaml(item, indent + 1)}`
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

  updateDynamicConfig(subdomains: string[]): void {
    writeFileSync(this.dynamicConfigPath, this.generateDynamicConfig(subdomains))
  }

  async start(): Promise<void> {
    // Write initial configs
    this.writeStaticConfig()
    this.updateDynamicConfig([])

    // Start Traefik process
    this.process = spawn({
      cmd: ["traefik", "--configFile", this.staticConfigPath],
      stdout: "inherit",
      stderr: "inherit",
    })

    console.log(`> Traefik started with PID ${this.process.pid}`)
  }

  stop(): void {
    if (this.process) {
      this.process.kill()
      this.process = null
    }
  }
}
