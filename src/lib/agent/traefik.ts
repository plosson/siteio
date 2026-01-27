import { existsSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { spawn, spawnSync } from "bun"

const CONTAINER_NAME = "siteio-traefik"
const TRAEFIK_IMAGE = "traefik:v3.0"

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

  generateDynamicConfig(subdomains: string[]): string {
    const { domain, fileServerPort } = this.config
    const routers: Record<string, unknown> = {}
    const services: Record<string, unknown> = {}

    // Use host.docker.internal to reach the host from container
    const hostUrl = `http://host.docker.internal:${fileServerPort}`

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
          servers: [{ url: hostUrl }],
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

  updateDynamicConfig(subdomains: string[]): void {
    writeFileSync(this.dynamicConfigPath, this.generateDynamicConfig(subdomains))
  }

  private isDockerAvailable(): boolean {
    const result = spawnSync({ cmd: ["docker", "info"], stdout: "pipe", stderr: "pipe" })
    return result.exitCode === 0
  }

  private isContainerRunning(): boolean {
    const result = spawnSync({
      cmd: ["docker", "inspect", "-f", "{{.State.Running}}", CONTAINER_NAME],
      stdout: "pipe",
      stderr: "pipe",
    })
    return result.exitCode === 0 && result.stdout.toString().trim() === "true"
  }

  private containerExists(): boolean {
    const result = spawnSync({
      cmd: ["docker", "inspect", CONTAINER_NAME],
      stdout: "pipe",
      stderr: "pipe",
    })
    return result.exitCode === 0
  }

  private removeContainer(): void {
    spawnSync({ cmd: ["docker", "rm", "-f", CONTAINER_NAME], stdout: "pipe", stderr: "pipe" })
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
    if (this.containerExists()) {
      console.log("> Removing existing Traefik container...")
      this.removeContainer()
    }

    const { httpPort, httpsPort } = this.config

    // Start Traefik container
    const args = [
      "docker",
      "run",
      "-d",
      "--name",
      CONTAINER_NAME,
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

    if (!this.isContainerRunning()) {
      // Get logs for debugging
      const logs = spawnSync({
        cmd: ["docker", "logs", CONTAINER_NAME],
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = logs.stdout.toString() + logs.stderr.toString()
      throw new Error(`Traefik container failed to start. Logs:\n${output}`)
    }
  }

  stop(): void {
    if (this.containerExists()) {
      console.log("> Stopping Traefik container...")
      spawnSync({ cmd: ["docker", "stop", CONTAINER_NAME], stdout: "pipe", stderr: "pipe" })
      spawnSync({ cmd: ["docker", "rm", CONTAINER_NAME], stdout: "pipe", stderr: "pipe" })
    }
  }
}
