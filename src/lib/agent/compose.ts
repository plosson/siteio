import { spawnSync } from "bun"
import { SiteioError } from "../../utils/errors"
import type { ComposeLogsOptions, ComposeServiceState } from "./runtime"

export interface ComposeSpec {
  services: Record<string, unknown>
  networks?: Record<string, unknown>
  volumes?: Record<string, unknown>
}

export function parsePsOutput(raw: string): ComposeServiceState[] {
  const trimmed = raw.trim()
  if (!trimmed) return []
  try {
    if (trimmed.startsWith("[")) {
      const parsed = JSON.parse(trimmed) as Array<{ Service: string; ID: string; State: string }>
      return parsed.map((p) => ({ service: p.Service, containerId: p.ID, state: p.State }))
    }
    return trimmed
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { Service: string; ID: string; State: string })
      .map((p) => ({ service: p.Service, containerId: p.ID, state: p.State }))
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
    return [...this.buildBaseArgs(project, files, envFile), "ps", "--format", "json"]
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
