import { existsSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { spawnSync } from "bun"
import { connect as tlsConnect, type PeerCertificate } from "tls"
import type { AcmeConfig } from "../../types.ts"

const TRAEFIK_CONTAINER_NAME = "siteio-traefik"
const TRAEFIK_IMAGE = "traefik:v3.7"

export interface TraefikConfig {
  dataDir: string
  domain: string
  email?: string
  httpPort: number
  httpsPort: number
  fileServerPort: number
  acme?: AcmeConfig
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
    const { httpPort, httpsPort, email, acme } = this.config
    const challengeType = acme?.challenge || "http"

    let challengeConfig: string
    switch (challengeType) {
      case "tls":
        challengeConfig = `      tlsChallenge: {}`
        break
      case "dns":
        challengeConfig = `      dnsChallenge:
        provider: ${acme!.dnsProvider}
        resolvers:
          - "1.1.1.1:53"
          - "8.8.8.8:53"`
        break
      case "http":
      default:
        challengeConfig = `      httpChallenge:
        entryPoint: web`
        break
    }

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
      email: ${email}
      storage: /certs/acme.json
${challengeConfig}

log:
  level: INFO
`.trim()
  }

  // The file provider carries only the `api.<domain>` router to the agent's
  // own HTTP server on the host. Everything else (sites and apps alike)
  // routes via docker-label discovery.
  generateDynamicConfig(): string {
    const { domain, fileServerPort } = this.config
    const hostUrl = `http://host.docker.internal:${fileServerPort}`

    const config: Record<string, unknown> = {
      http: {
        routers: {
          "api-router": {
            rule: `Host(\`api.${domain}\`)`,
            entryPoints: ["websecure"],
            service: "api-service",
            tls: {
              certResolver: "letsencrypt",
            },
          },
        },
        services: {
          "api-service": {
            loadBalancer: {
              servers: [{ url: hostUrl }],
            },
          },
        },
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

  updateDynamicConfig(): void {
    writeFileSync(this.dynamicConfigPath, this.generateDynamicConfig())
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

  async start(): Promise<void> {
    // Check Docker is available
    if (!this.isDockerAvailable()) {
      throw new Error("Docker is not available. Please install Docker to run siteio agent.")
    }

    // Write initial configs
    this.writeStaticConfig()
    this.updateDynamicConfig()

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
    ]

    // Pass DNS provider env vars to Traefik container (needed for DNS-01 challenge)
    const dnsEnv = this.config.acme?.dnsEnv
    if (dnsEnv) {
      for (const [key, value] of Object.entries(dnsEnv)) {
        args.push("-e", `${key}=${value}`)
      }
    }

    // Traefik image and config
    args.push(
      TRAEFIK_IMAGE,
      "--configFile=/etc/traefik/traefik.yml",
    )

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
        // Extract the base name (e.g., "siteio-mysite@docker" -> "siteio-mysite")
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
            // Invalid domain (e.g., a bare container name without dots)
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
    if (this.containerExists(TRAEFIK_CONTAINER_NAME)) {
      console.log("> Stopping Traefik container...")
      spawnSync({ cmd: ["docker", "stop", TRAEFIK_CONTAINER_NAME], stdout: "pipe", stderr: "pipe" })
      spawnSync({ cmd: ["docker", "rm", TRAEFIK_CONTAINER_NAME], stdout: "pipe", stderr: "pipe" })
    }
  }
}
