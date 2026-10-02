import type { App, AutoDeployMode } from "../../types"
import { ValidationError } from "../../utils/errors"

// Auto-deploy for single-container git apps: target selection (pure) and the
// poller. See docs/plans/2026-10-02-auto-deploy.md.

export const AUTO_DEPLOY_MODES: readonly AutoDeployMode[] = ["off", "commit", "tag"]

export function isAutoDeployMode(value: unknown): value is AutoDeployMode {
  return typeof value === "string" && (AUTO_DEPLOY_MODES as readonly string[]).includes(value)
}

/** `--auto-deploy <mode>` from the CLI. */
export function parseAutoDeployFlag(value: string): AutoDeployMode {
  if (!isAutoDeployMode(value)) {
    throw new ValidationError(`Invalid --auto-deploy value: ${value}. Valid values: ${AUTO_DEPLOY_MODES.join(", ")}`)
  }
  return value
}

export interface RemoteRef {
  ref: string
  sha: string
}

// What the poller would deploy. In commit mode `ref` is the SHA itself.
export interface DeployTarget {
  ref: string
  sha: string
}

const OBJECT_NAME = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const TAG_PREFIX = "refs/tags/"
const PEELED_SUFFIX = "^{}"

/** `git ls-remote` output: one `<sha>\t<ref>` per line. Anything else is skipped. */
export function parseLsRemote(stdout: string): RemoteRef[] {
  const refs: RemoteRef[] = []
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split("\t")
    if (fields.length !== 2) continue
    const [sha, ref] = fields as [string, string]
    if (!OBJECT_NAME.test(sha) || !ref) continue
    refs.push({ ref, sha })
  }
  return refs
}

/** `vX.Y.Z` as numbers, or null for anything else (pre-releases included). */
export function parseVersion(tag: string): [bigint, bigint, bigint] | null {
  const m = RELEASE_TAG.exec(tag)
  return m ? [BigInt(m[1]!), BigInt(m[2]!), BigInt(m[3]!)] : null
}

/** Order two `vX.Y.Z` tags. Throws if either is not one. */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (!va || !vb) throw new Error(`Not a vX.Y.Z tag: ${va ? b : a}`)
  for (let i = 0; i < 3; i++) {
    if (va[i]! !== vb[i]!) return va[i]! < vb[i]! ? -1 : 1
  }
  return 0
}

/** The refs to ask the remote for, so it sends back only those. */
export function refPatterns(mode: "commit" | "tag", branch: string): string[] {
  return mode === "commit" ? [`refs/heads/${branch}`] : [`${TAG_PREFIX}v*`]
}

/** The branch head (commit mode) or the highest release tag (tag mode). */
export function resolveTarget(mode: "commit" | "tag", branch: string, refs: RemoteRef[]): DeployTarget | null {
  if (mode === "commit") {
    const head = refs.find((r) => r.ref === `refs/heads/${branch}`)
    return head ? { ref: head.sha, sha: head.sha } : null
  }

  const tagged = new Map<string, string>()
  const peeled = new Map<string, string>()
  for (const { ref, sha } of refs) {
    if (!ref.startsWith(TAG_PREFIX)) continue
    const name = ref.slice(TAG_PREFIX.length)
    if (name.endsWith(PEELED_SUFFIX)) {
      peeled.set(name.slice(0, -PEELED_SUFFIX.length), sha)
    } else if (parseVersion(name)) {
      tagged.set(name, sha)
    }
  }

  let best: string | null = null
  for (const name of tagged.keys()) {
    if (!best || compareVersions(name, best) > 0) best = name
  }
  return best ? { ref: best, sha: peeled.get(best) ?? tagged.get(best)! } : null
}

/**
 * Whether the poller should deploy `target`. A target equal to
 * `autoDeployRef` was already tried, so a failed one is not retried.
 */
export function shouldDeploy(
  mode: "commit" | "tag",
  app: Pick<App, "commitHash" | "autoDeployRef">,
  target: DeployTarget
): boolean {
  if (target.ref === app.autoDeployRef) return false
  if (mode === "commit") return target.sha !== app.commitHash
  if (!app.autoDeployRef || !parseVersion(app.autoDeployRef)) return true
  return compareVersions(target.ref, app.autoDeployRef) > 0
}

/** Single-container git app with auto-deploy on. */
export function isAutoDeployable(app: Pick<App, "git" | "compose">): boolean {
  const mode = app.git?.autoDeploy
  return !app.compose && isAutoDeployMode(mode) && mode !== "off"
}

const DEFAULT_INTERVAL_SECONDS = 300
const MIN_INTERVAL_SECONDS = 60
const MAX_BACKOFF_MS = 60 * 60 * 1000
const TICK_MS = 15_000
// Prefix of a stored deploy failure; such an error outlives healthy checks until a deploy succeeds.
const DEPLOY_FAILED_PREFIX = "deploy failed for "

/** SITEIO_AUTODEPLOY_INTERVAL / autoDeployInterval, in whole seconds. */
export function parseAutoDeployInterval(value: unknown): number {
  if (value === undefined || value === "") return DEFAULT_INTERVAL_SECONDS
  const seconds = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(`SITEIO_AUTODEPLOY_INTERVAL must be a whole number of seconds, got: ${String(value)}`)
  }
  return Math.max(seconds, MIN_INTERVAL_SECONDS)
}

export interface AutoDeployDeps {
  listApps(): App[]
  getApp(name: string): App | null
  updateApp(name: string, patch: Partial<App>): void
  lsRemote(url: string, patterns: string[], token?: string): Promise<RemoteRef[]>
  deploy(name: string, ref?: string): Promise<void> // throws on failure; a 409 carries `status: 409`
  isDeploying(name: string): boolean
  log(line: string): void
  now(): number
  random(): number
}

interface Schedule {
  nextAt: number
  backoffMs: number // 0 after a successful check
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Checks each auto-deploy app's remote on an interval and deploys a new
 * commit or a higher release tag. One app at a time; schedules are in memory,
 * the last target acted on is stored on the app.
 */
export class AutoDeployer {
  private schedules = new Map<string, Schedule>()
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false

  constructor(
    private deps: AutoDeployDeps,
    private intervalMs: number
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      let apps: App[]
      try {
        apps = this.deps.listApps()
      } catch (err) {
        this.deps.log(`auto-deploy: ${messageOf(err)}`)
        return
      }
      const watched = new Set<string>()
      for (const listed of apps) {
        if (!isAutoDeployable(listed)) continue
        watched.add(listed.name)
        let schedule = this.schedules.get(listed.name)
        if (!schedule) {
          schedule = { nextAt: this.deps.now() + Math.floor(this.deps.random() * this.intervalMs), backoffMs: 0 }
          this.schedules.set(listed.name, schedule)
        }
        if (this.deps.now() < schedule.nextAt) continue
        try {
          await this.check(listed.name, schedule)
        } catch (err) {
          this.deps.log(`auto-deploy ${listed.name}: ${messageOf(err)}`)
        }
      }
      for (const name of this.schedules.keys()) {
        if (!watched.has(name)) this.schedules.delete(name)
      }
    } finally {
      this.ticking = false
    }
  }

  private async check(name: string, schedule: Schedule): Promise<void> {
    // Re-read: the app may have changed or gone since it was listed
    const app = this.deps.getApp(name)
    if (!app || !isAutoDeployable(app)) return
    // A deploy is running: stay due, try again next tick
    if (this.deps.isDeploying(name)) return

    const git = app.git!
    const mode = git.autoDeploy as "commit" | "tag"
    const checkedAt = new Date(this.deps.now()).toISOString()

    let target: DeployTarget | null
    try {
      const refs = await this.deps.lsRemote(git.repoUrl, refPatterns(mode, git.branch), git.token)
      target = resolveTarget(mode, git.branch, refs)
    } catch (err) {
      schedule.backoffMs = Math.min(
        schedule.backoffMs ? schedule.backoffMs * 2 : this.intervalMs * 2,
        Math.max(MAX_BACKOFF_MS, this.intervalMs)
      )
      schedule.nextAt = this.deps.now() + schedule.backoffMs
      const message = `check failed: ${messageOf(err)}`
      this.deps.updateApp(name, { autoDeployCheckedAt: checkedAt, autoDeployError: message })
      this.deps.log(`auto-deploy ${name}: ${message}`)
      return
    }

    schedule.backoffMs = 0
    schedule.nextAt = this.deps.now() + this.intervalMs

    if (!target) {
      const message = mode === "tag" ? "no vX.Y.Z tag found" : `branch '${git.branch}' not found`
      this.deps.updateApp(name, { autoDeployCheckedAt: checkedAt, autoDeployError: message })
      return
    }

    // A healthy check clears an error that came from a check; a deploy failure stays
    const clearable = app.autoDeployError && !app.autoDeployError.startsWith(DEPLOY_FAILED_PREFIX) ? { autoDeployError: undefined } : {}

    if (!shouldDeploy(mode, app, target)) {
      // A deploy failure stays visible until a deploy succeeds
      this.deps.updateApp(name, { autoDeployCheckedAt: checkedAt, ...clearable })
      return
    }

    const label = mode === "tag" ? target.ref : target.sha.slice(0, 7)
    const previousRef = app.autoDeployRef
    this.deps.updateApp(name, {
      autoDeployCheckedAt: checkedAt,
      autoDeployRef: target.ref,
      ...clearable,
    })
    this.deps.log(`auto-deploy ${name}: deploying ${label}`)

    try {
      await this.deps.deploy(name, mode === "tag" ? target.ref : undefined)
      this.deps.log(`auto-deploy ${name}: deployed ${label}`)
    } catch (err) {
      if ((err as { status?: number }).status === 409) {
        // A manual deploy started in between: this target was not tried
        this.deps.updateApp(name, { autoDeployRef: previousRef })
        schedule.nextAt = this.deps.now()
        this.deps.log(`auto-deploy ${name}: deploy in progress, retrying ${label} next tick`)
        return
      }
      const message = `${DEPLOY_FAILED_PREFIX}${label}: ${messageOf(err)}`
      this.deps.updateApp(name, { autoDeployError: message })
      this.deps.log(`auto-deploy ${name}: ${message}`)
    }
  }
}
