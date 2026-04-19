// src/lib/agent/runtime.ts
import type { BuildConfig, ContainerRunConfig } from "./docker"
import type { ContainerInspect } from "../../types"

export interface LogsOptions {
  tail: number
}

export interface ComposeLogsOptions {
  service?: string
  all?: boolean
  tail: number
}

export interface ComposeServiceState {
  service: string
  containerId: string
  state: string // "running" | "exited" | ...
}

/**
 * Abstracts container runtime operations (docker + docker compose) so that
 * AgentServer can be tested without shelling out. The default implementation
 * is DockerRuntime; tests inject FakeRuntime to record calls.
 */
export interface Runtime {
  // ---- Single-container ops (existing flows) ----
  isAvailable(): boolean
  ensureNetwork(networkName?: string): void
  imageTag(appName: string): string
  pull(image: string): Promise<void>
  build(config: BuildConfig): Promise<string>
  run(config: ContainerRunConfig): Promise<string>
  stop(appName: string): Promise<void>
  restart(appName: string): Promise<void>
  remove(appName: string): Promise<void>
  removeImage(tag: string): Promise<void>
  logs(appName: string, tail: number): Promise<string>
  isRunning(appName: string): boolean
  containerExists(appName: string): boolean
  inspect(appName: string): Promise<ContainerInspect | null>
  buildTraefikLabels(
    appName: string,
    domains: string[],
    port: number,
    requireAuth?: boolean
  ): Record<string, string>
  imageExists(tag: string): boolean

  // Compose methods added in Task 9 (left as TODO stubs until then).
}
