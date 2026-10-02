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
