// src/lib/agent/runtime.ts
import type { BuildConfig, ContainerRunConfig } from "./docker"
import type { ContainerInspect } from "../../types"
import type { ComposeDownOptions, ComposeSpec } from "./compose"

export interface LogsOptions {
  tail: number
}

export interface ComposeLogsOptions {
  service?: string
  all?: boolean
  tail: number
}

/**
 * Docker resources still tied to a compose project after `down`: containers
 * carrying its compose project label, and networks/volumes carrying the label
 * or compose's `<project>_` name prefix. Things created through the Docker
 * socket by the app itself (outside compose) are not listed.
 */
export interface ProjectLeftovers {
  containers: string[]
  networks: string[]
  volumes: string[]
  // Containers, any project, still mounting a leftover volume, by volume. This
  // is what usually keeps a volume alive: compose `down -v` skips a volume in
  // use and still exits 0.
  volumeUsers?: Record<string, string[]>
}

export interface ComposeServiceState {
  service: string
  containerId: string
  state: string // "running" | "exited" | "restarting" | "dead" | ...
  exitCode?: number // meaningful once the container has exited
  health?: string // "healthy" | "unhealthy" | "starting"; absent without a healthcheck
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
  containerName(appName: string): string
  pull(image: string): Promise<void>
  build(config: BuildConfig): Promise<string>
  run(config: ContainerRunConfig): Promise<string>
  stop(appName: string): Promise<void>
  restart(appName: string): Promise<void>
  remove(appName: string): Promise<void>
  // `force: false` lets Docker refuse to remove an image a container still uses
  removeImage(tag: string, opts?: { force?: boolean }): Promise<void>
  logs(appName: string, tail: number): Promise<string>
  isRunning(appName: string): boolean
  containerExists(appName: string): boolean
  inspect(appName: string): Promise<ContainerInspect | null>
  buildTraefikLabels(
    appName: string,
    domains: string[],
    port: number
  ): Record<string, string>
  imageExists(tag: string): boolean
  imageInspect(tag: string): Promise<{ id: string; labels: Record<string, string> }>

  // ---- Compose ops ----
  composeConfig(project: string, files: string[], envFile?: string): Promise<ComposeSpec>
  composeUp(project: string, files: string[], envFile?: string): Promise<void>
  composeStop(project: string, files: string[], envFile?: string): Promise<void>
  composeRestart(project: string, files: string[], envFile?: string): Promise<void>
  composeDown(project: string, files: string[], envFile?: string, opts?: ComposeDownOptions): Promise<void>
  projectLeftovers(project: string): Promise<ProjectLeftovers>
  composeLogs(project: string, files: string[], envFile: string | undefined, opts: ComposeLogsOptions): Promise<string>
  composePs(project: string, files: string[], envFile?: string): Promise<ComposeServiceState[]>
}
