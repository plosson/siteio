import { spawnSync } from "bun"
import { sep } from "path"
import { SiteioError } from "../../utils/errors"
import type { ComposeLogsOptions, ComposeServiceState } from "./runtime"

export interface ComposeSpec {
  services: Record<string, unknown>
  networks?: Record<string, unknown>
  volumes?: Record<string, unknown>
}

/** Error message when the resolved config has no such service, else null. */
export function missingPrimaryService(spec: ComposeSpec, primaryService: string): string | null {
  if (spec.services?.[primaryService]) return null
  const available = Object.keys(spec.services || {}).join(", ") || "none"
  return `Primary service '${primaryService}' not found in compose file. Available: ${available}`
}

interface ServiceSpec {
  ports?: unknown[]
  container_name?: string
  volumes?: Array<{ type?: string; source?: string; target?: string }>
}

/** "8080:80" for resolved port objects, the raw value for short-syntax strings. */
function formatPorts(ports: unknown[]): string {
  return ports
    .map((p) => {
      if (p && typeof p === "object" && "target" in p) {
        const { published, target } = p as { published?: string | number; target: number }
        return published ? `${published}:${target}` : String(target)
      }
      return String(p)
    })
    .join(", ")
}

/**
 * Hints about patterns that work but don't suit siteio-managed apps, from a
 * resolved compose config (`docker compose config`):
 *   - published `ports:` (Traefik handles external access; host ports bypass
 *     HTTPS and may conflict with other apps)
 *   - `container_name:` (fixed names clash with other containers)
 *   - bind mounts under `uploadedRoot`: compose resolves relative paths
 *     (`./data`) against the uploaded file's folder, which holds only the
 *     compose file, so the folder is empty on the server
 */
export function composeWarnings(spec: ComposeSpec, primaryService: string, uploadedRoot?: string): string[] {
  const warnings: string[] = []
  const root = uploadedRoot && (uploadedRoot.endsWith(sep) ? uploadedRoot : uploadedRoot + sep)

  for (const [name, def] of Object.entries(spec.services ?? {})) {
    const svc = (def ?? {}) as ServiceSpec
    if (Array.isArray(svc.ports) && svc.ports.length > 0) {
      warnings.push(
        name === primaryService
          ? `Primary service '${name}' publishes ports (${formatPorts(svc.ports)}). Traefik handles external access; host port bindings are redundant and may conflict with other apps on the same server.`
          : `Service '${name}' publishes ports (${formatPorts(svc.ports)}). They are reachable on the server outside HTTPS; remove them unless you need direct access.`
      )
    }
    if (svc.container_name) {
      warnings.push(
        `Service '${name}' sets container_name='${svc.container_name}'. Fixed container names prevent deploying multiple instances of this app.`
      )
    }
    for (const vol of Array.isArray(svc.volumes) ? svc.volumes : []) {
      if (root && vol.type === "bind" && vol.source?.startsWith(root)) {
        warnings.push(
          `Service '${name}' bind-mounts a relative path to '${vol.target}'. Only the compose file is uploaded, so that folder is empty on the server; use a named volume instead.`
        )
      }
    }
  }

  return warnings
}

interface RawPsEntry {
  Service: string
  ID: string
  State: string
  ExitCode?: number
  Health?: string
}

function toServiceState(p: RawPsEntry): ComposeServiceState {
  return {
    service: p.Service,
    containerId: p.ID,
    state: p.State,
    ...(typeof p.ExitCode === "number" && { exitCode: p.ExitCode }),
    ...(p.Health && { health: p.Health }),
  }
}

export function parsePsOutput(raw: string): ComposeServiceState[] {
  const trimmed = raw.trim()
  if (!trimmed) return []
  try {
    if (trimmed.startsWith("[")) {
      return (JSON.parse(trimmed) as RawPsEntry[]).map(toServiceState)
    }
    return trimmed
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => toServiceState(JSON.parse(l) as RawPsEntry))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new SiteioError(`Failed to parse compose ps output: ${message}`)
  }
}

/**
 * Thin wrapper around `docker compose` subcommands. Every method takes the
 * compose project name + list of compose files (base, override), mirroring the
 * CLI's -p / -f flags so tests can predict the exact argv.
 */
export class ComposeManager {
  buildBaseArgs(project: string, files: string[], envFile?: string): string[] {
    const args: string[] = ["compose", "-p", project]
    for (const f of files) {
      args.push("-f", f)
    }
    if (envFile) {
      args.push("--env-file", envFile)
    }
    return args
  }

  buildUpArgs(project: string, files: string[], envFile?: string): string[] {
    return [...this.buildBaseArgs(project, files, envFile), "up", "-d", "--build", "--remove-orphans"]
  }

  buildDownArgs(project: string, files: string[], envFile?: string): string[] {
    return [...this.buildBaseArgs(project, files, envFile), "down", "-v", "--remove-orphans"]
  }

  buildStopArgs(project: string, files: string[], envFile?: string): string[] {
    return [...this.buildBaseArgs(project, files, envFile), "stop"]
  }

  buildRestartArgs(project: string, files: string[], envFile?: string): string[] {
    return [...this.buildBaseArgs(project, files, envFile), "restart"]
  }

  buildConfigArgs(project: string, files: string[], envFile?: string): string[] {
    return [...this.buildBaseArgs(project, files, envFile), "config", "--format", "json"]
  }

  buildPsArgs(project: string, files: string[], envFile?: string): string[] {
    // --all: exited and crash-looping containers are what a health check needs to see
    return [...this.buildBaseArgs(project, files, envFile), "ps", "--all", "--format", "json"]
  }

  buildLogsArgs(project: string, files: string[], envFile: string | undefined, opts: ComposeLogsOptions): string[] {
    const args = [...this.buildBaseArgs(project, files, envFile), "logs", "--no-color", "--tail", String(opts.tail)]
    // `all: true` overrides service — we want every service's logs
    if (!opts.all && opts.service) {
      args.push(opts.service)
    }
    return args
  }

  async up(project: string, files: string[], envFile?: string): Promise<void> {
    const result = spawnSync({
      cmd: ["docker", ...this.buildUpArgs(project, files, envFile)],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      throw new SiteioError(`docker compose up failed: ${result.stderr.toString()}`)
    }
  }

  async down(project: string, files: string[], envFile?: string): Promise<void> {
    const result = spawnSync({
      cmd: ["docker", ...this.buildDownArgs(project, files, envFile)],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      throw new SiteioError(`docker compose down failed: ${result.stderr.toString()}`)
    }
  }

  async stop(project: string, files: string[], envFile?: string): Promise<void> {
    const result = spawnSync({
      cmd: ["docker", ...this.buildStopArgs(project, files, envFile)],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      throw new SiteioError(`docker compose stop failed: ${result.stderr.toString()}`)
    }
  }

  async restart(project: string, files: string[], envFile?: string): Promise<void> {
    const result = spawnSync({
      cmd: ["docker", ...this.buildRestartArgs(project, files, envFile)],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      throw new SiteioError(`docker compose restart failed: ${result.stderr.toString()}`)
    }
  }

  async config(project: string, files: string[], envFile?: string): Promise<ComposeSpec> {
    const result = spawnSync({
      cmd: ["docker", ...this.buildConfigArgs(project, files, envFile)],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      throw new SiteioError(`docker compose config failed: ${result.stderr.toString()}`)
    }
    try {
      return JSON.parse(result.stdout.toString()) as ComposeSpec
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new SiteioError(`Failed to parse compose config output: ${message}`)
    }
  }

  async ps(project: string, files: string[], envFile?: string): Promise<ComposeServiceState[]> {
    const result = spawnSync({
      cmd: ["docker", ...this.buildPsArgs(project, files, envFile)],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      throw new SiteioError(`docker compose ps failed: ${result.stderr.toString()}`)
    }
    return parsePsOutput(result.stdout.toString())
  }

  async logs(project: string, files: string[], envFile: string | undefined, opts: ComposeLogsOptions): Promise<string> {
    const result = spawnSync({
      cmd: ["docker", ...this.buildLogsArgs(project, files, envFile, opts)],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      throw new SiteioError(`docker compose logs failed: ${result.stderr.toString()}`)
    }
    // docker compose logs writes each service's stream to whichever channel the
    // container used; concatenating captures both. Interleave order is lost but
    // acceptable for tail-style operator dumps.
    return result.stdout.toString() + result.stderr.toString()
  }
}
