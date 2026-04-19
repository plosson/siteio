// src/__tests__/helpers/fake-runtime.ts
import type { BuildConfig, ContainerRunConfig } from "../../lib/agent/docker"
import type { ContainerInspect } from "../../types"
import type { Runtime } from "../../lib/agent/runtime"
import type { ComposeSpec } from "../../lib/agent/compose"
import type { ComposeLogsOptions, ComposeServiceState } from "../../lib/agent/runtime"

export interface RecordedCall {
  method: string
  args: unknown[]
}

/**
 * Runtime that records every call and returns configurable fixtures.
 * Tests assert against `fake.calls` to verify siteio invoked the right docker
 * operations in the right order.
 */
export class FakeRuntime implements Runtime {
  calls: RecordedCall[] = []

  // Fixtures tests can override per-test:
  runReturn = "fake-container-id-123"
  buildReturn = "siteio-fake:latest"
  logsReturn = ""
  inspectReturn: ContainerInspect | null = null
  isAvailableReturn = true
  imageExistsReturn = false
  isRunningReturn = true
  containerExistsReturn = false

  // Compose fixtures
  composeConfigReturn: ComposeSpec = { services: { web: {} } }
  composePsReturn: ComposeServiceState[] = [
    { service: "web", containerId: "fake-web-id", state: "running" },
  ]
  composeLogsReturn = ""

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args })
  }

  isAvailable(): boolean {
    this.record("isAvailable", [])
    return this.isAvailableReturn
  }

  ensureNetwork(networkName?: string): void {
    this.record("ensureNetwork", [networkName])
  }

  imageTag(appName: string): string {
    this.record("imageTag", [appName])
    return `siteio-${appName}:latest`
  }

  async pull(image: string): Promise<void> {
    this.record("pull", [image])
  }

  async build(config: BuildConfig): Promise<string> {
    this.record("build", [config])
    return this.buildReturn
  }

  async run(config: ContainerRunConfig): Promise<string> {
    this.record("run", [config])
    return this.runReturn
  }

  async stop(appName: string): Promise<void> {
    this.record("stop", [appName])
  }

  async restart(appName: string): Promise<void> {
    this.record("restart", [appName])
  }

  async remove(appName: string): Promise<void> {
    this.record("remove", [appName])
  }

  async removeImage(tag: string): Promise<void> {
    this.record("removeImage", [tag])
  }

  async logs(appName: string, tail: number): Promise<string> {
    this.record("logs", [appName, tail])
    return this.logsReturn
  }

  isRunning(appName: string): boolean {
    this.record("isRunning", [appName])
    return this.isRunningReturn
  }

  containerExists(appName: string): boolean {
    this.record("containerExists", [appName])
    return this.containerExistsReturn
  }

  async inspect(appName: string): Promise<ContainerInspect | null> {
    this.record("inspect", [appName])
    return this.inspectReturn
  }

  buildTraefikLabels(
    appName: string,
    domains: string[],
    port: number,
    requireAuth?: boolean
  ): Record<string, string> {
    this.record("buildTraefikLabels", [appName, domains, port, requireAuth])
    const containerName = `siteio-${appName}`
    return {
      "traefik.enable": "true",
      [`traefik.http.routers.${containerName}.entrypoints`]: "websecure",
      [`traefik.http.routers.${containerName}.tls.certresolver`]: "letsencrypt",
      [`traefik.http.services.${containerName}.loadbalancer.server.port`]: String(port),
      ...(domains.length > 0
        ? {
            [`traefik.http.routers.${containerName}.rule`]: domains.map((d) => `Host(\`${d}\`)`).join(" || "),
          }
        : {}),
    }
  }

  imageExists(tag: string): boolean {
    this.record("imageExists", [tag])
    return this.imageExistsReturn
  }

  async composeConfig(project: string, files: string[], envFile?: string): Promise<ComposeSpec> {
    this.record("composeConfig", [project, files, envFile])
    return this.composeConfigReturn
  }
  async composeUp(project: string, files: string[], envFile?: string): Promise<void> {
    this.record("composeUp", [project, files, envFile])
  }
  async composeStop(project: string, files: string[], envFile?: string): Promise<void> {
    this.record("composeStop", [project, files, envFile])
  }
  async composeRestart(project: string, files: string[], envFile?: string): Promise<void> {
    this.record("composeRestart", [project, files, envFile])
  }
  async composeDown(project: string, files: string[], envFile?: string): Promise<void> {
    this.record("composeDown", [project, files, envFile])
  }
  async composeLogs(
    project: string,
    files: string[],
    envFile: string | undefined,
    opts: ComposeLogsOptions
  ): Promise<string> {
    this.record("composeLogs", [project, files, envFile, opts])
    return this.composeLogsReturn
  }
  async composePs(project: string, files: string[], envFile?: string): Promise<ComposeServiceState[]> {
    this.record("composePs", [project, files, envFile])
    return this.composePsReturn
  }

  // Helper: filter recorded calls by method name
  callsOf(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method)
  }
}
