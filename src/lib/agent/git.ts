import { spawnSync } from "bun"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { SiteioError } from "../../utils/errors"
import { parseLsRemote, type RemoteRef } from "./auto-deploy"

// Helper invoked by git through GIT_ASKPASS. Reads the token from the env var
// we set on the clone subprocess so it never lands in argv or stderr.
// $1 is the prompt ("Username for 'https://…': " or "Password for …").
// For GitHub PATs, username is conventionally "x-access-token"; the token
// itself is the password.
const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  Username*) printf '%s' "x-access-token" ;;
  *) printf '%s' "$SITEIO_GIT_TOKEN" ;;
esac
`

function redactToken(text: string, token: string | undefined): string {
  if (!token) return text
  return text.split(token).join("***")
}

// Auth and repository-access failures, worded the same for every git command.
// GitHub hides private repos behind "Repository not found", so this must run
// before any "not found" check of a caller.
function accessErrorMessage(stderr: string, opts: { url: string; hasToken: boolean }): string | undefined {
  if (
    stderr.includes("Authentication failed") ||
    stderr.includes("could not read Username") ||
    stderr.includes("could not read Password")
  ) {
    return opts.hasToken
      ? "Authentication failed for repository — check the git token"
      : "Authentication required for repository — supply a token with --git-token"
  }
  if (stderr.includes("Repository not found") || stderr.includes("not appear to be a git repository")) {
    return `Repository not found (or token lacks access): ${opts.url}`
  }
  return undefined
}

// Map git clone stderr to a clear, accurate error message.
//
// Order matters: GitHub hides private repos behind "Repository not found" (which
// contains the substring "not found"), so the branch check must be specific to
// real "remote branch missing" messages and must run AFTER the auth and
// repository-not-found checks — otherwise an auth/access failure is mislabeled
// as "Branch '<branch>' not found".
export function cloneErrorMessage(
  stderr: string,
  opts: { branch: string; url: string; hasToken: boolean },
): string {
  const access = accessErrorMessage(stderr, opts)
  if (access) return access
  if (
    stderr.includes("Remote branch") ||
    stderr.includes("not found in upstream") ||
    stderr.includes("does not exist")
  ) {
    return `Branch '${opts.branch}' not found in repository`
  }
  return `Failed to clone repository: ${stderr}`
}

/** Map `git ls-remote` stderr to a clear error message. */
export function lsRemoteErrorMessage(stderr: string, opts: { url: string; hasToken: boolean }): string {
  return accessErrorMessage(stderr, opts) ?? `Failed to list remote refs: ${stderr}`
}

// Ssh never prompts (no tty on the agent) and gives up on a dead connection.
const SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=2"

/**
 * Run git, killed after `timeoutMs`. Bun's timeout kills only `git`, not its
 * git-remote-http child, so the transport is also told to abort itself when
 * the transfer stalls for that long. Throws `timeoutMessage` on a timeout.
 */
async function runGit(
  args: string[],
  opts: { env: Record<string, string>; timeoutMs: number; timeoutMessage: string }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const lowSpeedTime = String(Math.max(1, Math.ceil(opts.timeoutMs / 1000)))
  const proc = Bun.spawn({
    cmd: ["git", "-c", "http.lowSpeedLimit=1", "-c", `http.lowSpeedTime=${lowSpeedTime}`, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env,
    timeout: opts.timeoutMs,
  })
  // Read the pipes concurrently, but decide on the exit first: when the kill
  // lands, git's transport child can hold the pipes open until its own
  // network timeout, so a timed-out call must not wait for them.
  const stdoutP = new Response(proc.stdout).text()
  const stderrP = new Response(proc.stderr).text()
  const exitCode = await proc.exited
  if (proc.signalCode) {
    // Abandoned reads: a later stream error must not become an unhandled rejection.
    stdoutP.catch(() => {})
    stderrP.catch(() => {})
    throw new SiteioError(opts.timeoutMessage)
  }
  const [stdout, stderr] = await Promise.all([stdoutP, stderrP])
  return { exitCode, stdout, stderr }
}

// `git clone` argv for a shallow clone of `ref`. The `--` keeps a URL that
// starts with '-' from being read as an option.
export function cloneArgs(url: string, ref: string, targetDir: string): string[] {
  return ["clone", "--depth", "1", "--branch", ref, "--", url, targetDir]
}

function seconds(ms: number): number {
  return Math.round(ms / 1000)
}

export class GitManager {
  private reposDir: string

  constructor(dataDir: string) {
    this.reposDir = join(dataDir, "repos")
  }

  /**
   * Get the local path for a cloned repo
   */
  repoPath(appName: string): string {
    return join(this.reposDir, appName)
  }

  /**
   * Environment for a git subprocess. With a token, git reads it through
   * GIT_ASKPASS so it never lands in argv or stderr. Call cleanup() when the
   * subprocess has exited.
   */
  private gitEnv(token?: string): { env: Record<string, string>; cleanup: () => void } {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      GIT_TERMINAL_PROMPT: "0",
    }
    if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = SSH_COMMAND
    if (!token) return { env, cleanup: () => {} }

    const askpassDir = mkdtempSync(join(tmpdir(), "siteio-askpass-"))
    const askpassPath = join(askpassDir, "askpass.sh")
    writeFileSync(askpassPath, ASKPASS_SCRIPT)
    chmodSync(askpassPath, 0o700)
    env.GIT_ASKPASS = askpassPath
    env.SITEIO_GIT_TOKEN = token
    return { env, cleanup: () => rmSync(askpassDir, { recursive: true, force: true }) }
  }

  /**
   * Clone a repository at a branch or tag (shallow clone for speed).
   * Always does a fresh clone - removes existing repo first. Killed after `timeoutMs`.
   */
  async clone(appName: string, url: string, ref: string, token?: string, timeoutMs = 300_000): Promise<void> {
    const targetDir = this.repoPath(appName)

    // Remove existing repo if present
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true })
    }

    const { env, cleanup } = this.gitEnv(token)
    try {
      const result = await runGit(cloneArgs(url, ref, targetDir), {
        env,
        timeoutMs,
        timeoutMessage: `Timed out cloning repository after ${seconds(timeoutMs)}s`,
      })
      if (result.exitCode !== 0) {
        const stderr = redactToken(result.stderr, token)
        throw new SiteioError(cloneErrorMessage(stderr, { branch: ref, url, hasToken: !!token }))
      }
    } finally {
      cleanup()
    }
  }

  /**
   * List the remote refs matching `patterns` without cloning. Protocol v2 lets
   * the server send only those refs. Killed after `timeoutMs`.
   */
  async lsRemote(url: string, patterns: string[], token?: string, timeoutMs = 30_000): Promise<RemoteRef[]> {
    const { env, cleanup } = this.gitEnv(token)
    try {
      const result = await runGit(["-c", "protocol.version=2", "ls-remote", "--", url, ...patterns], {
        env,
        timeoutMs,
        timeoutMessage: `Timed out listing remote refs after ${seconds(timeoutMs)}s`,
      })
      if (result.exitCode !== 0) {
        throw new SiteioError(lsRemoteErrorMessage(redactToken(result.stderr, token), { url, hasToken: !!token }))
      }
      return parseLsRemote(result.stdout)
    } finally {
      cleanup()
    }
  }

  /**
   * Get the current commit hash of a cloned repo
   */
  async getCommitHash(appName: string): Promise<string> {
    const repoDir = this.repoPath(appName)

    if (!existsSync(repoDir)) {
      throw new SiteioError(`Repository not found for app: ${appName}`)
    }

    const result = spawnSync({
      cmd: ["git", "-C", repoDir, "rev-parse", "HEAD"],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (result.exitCode !== 0) {
      throw new SiteioError(`Failed to get commit hash: ${result.stderr.toString()}`)
    }

    return result.stdout.toString().trim()
  }

  /**
   * Remove a cloned repository
   */
  async remove(appName: string): Promise<void> {
    const repoDir = this.repoPath(appName)
    if (existsSync(repoDir)) {
      rmSync(repoDir, { recursive: true, force: true })
    }
  }

  /**
   * Check if a repo exists locally
   */
  exists(appName: string): boolean {
    return existsSync(this.repoPath(appName))
  }
}
