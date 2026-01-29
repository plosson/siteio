import { spawnSync } from "bun"
import { join } from "path"
import type { ContainerInspect, RestartPolicy, VolumeMount } from "../../types"
import { SiteioError } from "../../utils/errors"

export interface ContainerRunConfig {
  name: string
  image: string
  internalPort: number
  env: Record<string, string>
  volumes: VolumeMount[]
  restartPolicy: RestartPolicy
  network: string
  labels: Record<string, string>
  command?: string[]
}

export class DockerManager {
  private dataDir: string
  private volumesDir: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.volumesDir = join(dataDir, "volumes")
  }

  /**
   * Check if Docker daemon is available
   */
  isAvailable(): boolean {
    const result = spawnSync({
      cmd: ["docker", "info"],
      stdout: "pipe",
      stderr: "pipe",
    })
    return result.exitCode === 0
  }

  /**
   * Generate the siteio container name for an app
   */
  containerName(appName: string): string {
    return `siteio-${appName}`
  }

  /**
   * Build docker run arguments from config
   */
  buildRunArgs(config: ContainerRunConfig): string[] {
    const containerName = this.containerName(config.name)
    const args: string[] = [
      "run",
      "-d",
      "--name",
      containerName,
      "--network",
      config.network,
      "--restart",
      config.restartPolicy,
    ]

    // Add environment variables
    for (const [key, value] of Object.entries(config.env)) {
      args.push("-e", `${key}=${value}`)
    }

    // Add volume mounts
    for (const vol of config.volumes) {
      // If name is an absolute path, use it directly; otherwise use volumesDir
      const hostPath = vol.name.startsWith("/")
        ? vol.name
        : join(this.volumesDir, config.name, vol.name)
      const volumeSpec = vol.readonly
        ? `${hostPath}:${vol.mountPath}:ro`
        : `${hostPath}:${vol.mountPath}`
      args.push("-v", volumeSpec)
    }

    // Add labels
    for (const [key, value] of Object.entries(config.labels)) {
      args.push("-l", `${key}=${value}`)
    }

    // Add command if specified
    if (config.command && config.command.length > 0) {
      args.push(config.image, ...config.command)
    } else {
      args.push(config.image)
    }

    return args
  }

  /**
   * Ensure the siteio-network exists
   */
  ensureNetwork(networkName: string = "siteio-network"): void {
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
        throw new SiteioError(`Failed to create Docker network: ${create.stderr.toString()}`)
      }
    }
  }

  /**
   * Pull a Docker image
   */
  async pull(image: string): Promise<void> {
    const result = spawnSync({
      cmd: ["docker", "pull", image],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (result.exitCode !== 0) {
      throw new SiteioError(`Failed to pull image ${image}: ${result.stderr.toString()}`)
    }
  }

  /**
   * Run a container with the given configuration
   */
  async run(config: ContainerRunConfig): Promise<string> {
    const args = this.buildRunArgs(config)

    const result = spawnSync({
      cmd: ["docker", ...args],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (result.exitCode !== 0) {
      throw new SiteioError(`Failed to run container: ${result.stderr.toString()}`)
    }

    // Return container ID
    return result.stdout.toString().trim()
  }

  /**
   * Stop a container
   */
  async stop(appName: string): Promise<void> {
    const containerName = this.containerName(appName)
    const result = spawnSync({
      cmd: ["docker", "stop", containerName],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (result.exitCode !== 0) {
      throw new SiteioError(`Failed to stop container: ${result.stderr.toString()}`)
    }
  }

  /**
   * Remove a container
   */
  async remove(appName: string): Promise<void> {
    const containerName = this.containerName(appName)
    const result = spawnSync({
      cmd: ["docker", "rm", "-f", containerName],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (result.exitCode !== 0 && !result.stderr.toString().includes("No such container")) {
      throw new SiteioError(`Failed to remove container: ${result.stderr.toString()}`)
    }
  }

  /**
   * Get container logs
   */
  async logs(appName: string, tail: number = 100): Promise<string> {
    const containerName = this.containerName(appName)
    const result = spawnSync({
      cmd: ["docker", "logs", "--tail", tail.toString(), containerName],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (result.exitCode !== 0) {
      throw new SiteioError(`Failed to get logs: ${result.stderr.toString()}`)
    }

    // Docker sends logs to both stdout and stderr
    return result.stdout.toString() + result.stderr.toString()
  }

  /**
   * Check if a container is running
   */
  isRunning(appName: string): boolean {
    const containerName = this.containerName(appName)
    const result = spawnSync({
      cmd: ["docker", "inspect", "-f", "{{.State.Running}}", containerName],
      stdout: "pipe",
      stderr: "pipe",
    })

    return result.exitCode === 0 && result.stdout.toString().trim() === "true"
  }

  /**
   * Check if a container exists (running or stopped)
   */
  containerExists(appName: string): boolean {
    const containerName = this.containerName(appName)
    const result = spawnSync({
      cmd: ["docker", "inspect", containerName],
      stdout: "pipe",
      stderr: "pipe",
    })

    return result.exitCode === 0
  }

  /**
   * Inspect a container
   */
  async inspect(appName: string): Promise<ContainerInspect | null> {
    const containerName = this.containerName(appName)
    const result = spawnSync({
      cmd: ["docker", "inspect", containerName],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (result.exitCode !== 0) {
      return null
    }

    try {
      const data = JSON.parse(result.stdout.toString())[0]
      return {
        id: data.Id,
        name: data.Name.replace(/^\//, ""),
        state: {
          running: data.State.Running,
          status: data.State.Status,
          startedAt: data.State.StartedAt,
          exitCode: data.State.ExitCode,
        },
        image: data.Config.Image,
        ports: data.NetworkSettings?.Ports || {},
      }
    } catch {
      return null
    }
  }

  /**
   * Restart a container
   */
  async restart(appName: string): Promise<void> {
    const containerName = this.containerName(appName)
    const result = spawnSync({
      cmd: ["docker", "restart", containerName],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (result.exitCode !== 0) {
      throw new SiteioError(`Failed to restart container: ${result.stderr.toString()}`)
    }
  }

  /**
   * Build Traefik labels for routing
   */
  buildTraefikLabels(
    appName: string,
    domains: string[],
    port: number,
    requireAuth: boolean = false
  ): Record<string, string> {
    const containerName = this.containerName(appName)
    const labels: Record<string, string> = {
      "traefik.enable": "true",
      [`traefik.http.routers.${containerName}.entrypoints`]: "websecure",
      [`traefik.http.routers.${containerName}.tls.certresolver`]: "letsencrypt",
      [`traefik.http.services.${containerName}.loadbalancer.server.port`]: String(port),
    }

    if (domains.length > 0) {
      const hostRules = domains.map((d) => `Host(\`${d}\`)`).join(" || ")
      labels[`traefik.http.routers.${containerName}.rule`] = hostRules
    }

    if (requireAuth) {
      labels[`traefik.http.routers.${containerName}.middlewares`] = "siteio-auth@file"
    }

    return labels
  }
}
