import * as fs from "fs"
import * as path from "path"
import { CONFIG_DIR } from "../config/loader.ts"
import { getVersion, isReleaseBinary } from "../lib/version.ts"
import {
  compareVersions,
  getAssetName,
  getPlatform,
  resolveDownloadUrl,
  resolveLatestRelease,
  updateBinary,
} from "./update.ts"

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const CHECK_TIMEOUT_MS = 3000
// A lock older than this belongs to a process that died mid-update.
const STALE_LOCK_MS = 10 * 60 * 1000
// Set on the relaunched process so it never updates (and relaunches) again.
const RELAUNCHED_ENV = "SITEIO_AUTO_UPDATED"
// Commands that never trigger an automatic update: `update` does it explicitly,
// and `agent` runs the server, whose host decides when it changes.
const SKIP_COMMANDS = new Set(["update", "agent"])

export interface AutoUpdateDeps {
  now: () => number
  isRelease: () => boolean
  execPath: string
  stateDir: string
  install: (downloadUrl: string, execPath: string) => Promise<void>
  /** Runs the same command on the new binary and resolves to its exit code. */
  relaunch: (execPath: string) => Promise<number>
  exit: (code: number) => never
}

function readLastCheck(file: string): number | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf-8")).lastCheck
    return typeof value === "number" && Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

/** Takes the update lock, or returns false when another process holds it. */
function acquireLock(file: string, now: number): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    fs.writeFileSync(file, String(process.pid), { flag: "wx" })
    return true
  } catch {
    try {
      if (now - fs.statSync(file).mtimeMs < STALE_LOCK_MS) return false
      fs.unlinkSync(file)
      fs.writeFileSync(file, String(process.pid), { flag: "wx" })
      return true
    } catch {
      return false
    }
  }
}

function releaseLock(file: string): void {
  try {
    fs.unlinkSync(file)
  } catch {
    // Already gone
  }
}

function majorOf(version: string): number {
  return Number(version.replace(/^v/, "").split(".")[0]) || 0
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer from GitHub within ${ms / 1000}s`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function canWrite(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

async function relaunchCurrentCommand(execPath: string): Promise<number> {
  // In a compiled binary argv is [bun, /$bunfs/root/<entry>, ...user args].
  const child = Bun.spawn([execPath, ...process.argv.slice(2)], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, [RELAUNCHED_ENV]: "1" },
  })
  // The terminal sends Ctrl-C to the child too; stay alive to return its exit code.
  process.on("SIGINT", () => {})
  process.on("SIGTERM", () => child.kill("SIGTERM"))
  return child.exited
}

const defaultDeps: AutoUpdateDeps = {
  now: () => Date.now(),
  isRelease: isReleaseBinary,
  execPath: process.execPath,
  stateDir: CONFIG_DIR,
  install: updateBinary,
  relaunch: relaunchCurrentCommand,
  exit: (code) => process.exit(code),
}

/**
 * At most once every 24 hours, installs a newer minor or patch release and
 * reruns the requested command on it. A new major version is only announced.
 * Never fails the command: any problem is one line on stderr.
 */
export async function maybeAutoUpdate(commandPath: string[], deps: AutoUpdateDeps = defaultDeps): Promise<void> {
  if (commandPath.some((name) => SKIP_COMMANDS.has(name))) return
  if (process.env.SITEIO_NO_AUTO_UPDATE || process.env.CI || process.env[RELAUNCHED_ENV]) return
  if (!deps.isRelease() || !canWrite(path.dirname(deps.execPath))) return

  const stateFile = path.join(deps.stateDir, "update-check.json")
  const lockFile = path.join(deps.stateDir, "update.lock")
  const now = deps.now()
  const lastCheck = readLastCheck(stateFile)
  // A check "in the future" comes from a wrong clock; treat it as due.
  if (lastCheck !== null && lastCheck <= now && now - lastCheck < CHECK_INTERVAL_MS) return

  let locked = false
  try {
    locked = acquireLock(lockFile, now)
    if (!locked) return
    // Recorded before the network call, so an offline machine does not retry on every command.
    fs.writeFileSync(stateFile, JSON.stringify({ lastCheck: now }) + "\n")

    const current = getVersion()
    const release = await withTimeout(resolveLatestRelease(), CHECK_TIMEOUT_MS)
    const latest = release.tag.replace(/^v/, "")
    if (compareVersions(current, latest) <= 0) return

    if (majorOf(latest) > majorOf(current)) {
      console.error(`siteio ${latest} is available (major version). Run: siteio update`)
      return
    }

    const platform = getPlatform()
    const downloadUrl = await resolveDownloadUrl(release, getAssetName(platform), platform)
    console.error(`Updating siteio ${current} -> ${latest}...`)
    await deps.install(downloadUrl, deps.execPath)
    console.error(`Updated siteio to ${latest}`)
  } catch (error) {
    console.error(`siteio: automatic update skipped: ${error instanceof Error ? error.message : String(error)}`)
    return
  } finally {
    if (locked) releaseLock(lockFile)
  }

  deps.exit(await deps.relaunch(deps.execPath))
}
