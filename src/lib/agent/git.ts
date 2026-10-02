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
   * Always does a fresh clone - removes existing repo first
   */
  async clone(appName: string, url: string, ref: string, token?: string): Promise<void> {
    const targetDir = this.repoPath(appName)

    // Remove existing repo if present
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true })
    }

    const { env, cleanup } = this.gitEnv(token)
    try {
      const result = spawnSync({
        cmd: ["git", "clone", "--depth", "1", "--branch", ref, url, targetDir],
        stdout: "pipe",
        stderr: "pipe",
        env,
      })

      if (result.exitCode !== 0) {
        const stderr = redactToken(result.stderr.toString(), token)
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
      const proc = Bun.spawn({
        cmd: ["git", "-c", "protocol.version=2", "ls-remote", url, ...patterns],
        stdout: "pipe",
        stderr: "pipe",
        env,
        timeout: timeoutMs,
      })
      // Read the pipes concurrently, but decide on the exit first: when the kill
      // lands, git's transport child can hold the pipes open until its own
      // network timeout, so a timed-out call must not wait for them.
      const stdoutP = new Response(proc.stdout).text()
      const stderrP = new Response(proc.stderr).text()
      const exitCode = await proc.exited
      if (proc.signalCode) {
        throw new SiteioError(`Timed out listing remote refs after ${Math.round(timeoutMs / 1000)}s`)
      }
      const [stdout, stderr] = await Promise.all([stdoutP, stderrP])
      if (exitCode !== 0) {
        throw new SiteioError(lsRemoteErrorMessage(redactToken(stderr, token), { url, hasToken: !!token }))
      }
      return parseLsRemote(stdout)
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
