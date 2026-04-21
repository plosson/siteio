import { spawnSync } from "bun"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { SiteioError } from "../../utils/errors"

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
   * Clone a repository (shallow clone for speed)
   * Always does a fresh clone - removes existing repo first
   */
  async clone(appName: string, url: string, branch: string, token?: string): Promise<void> {
    const targetDir = this.repoPath(appName)

    // Remove existing repo if present
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true })
    }

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      GIT_TERMINAL_PROMPT: "0",
    }

    let askpassDir: string | undefined
    if (token) {
      askpassDir = mkdtempSync(join(tmpdir(), "siteio-askpass-"))
      const askpassPath = join(askpassDir, "askpass.sh")
      writeFileSync(askpassPath, ASKPASS_SCRIPT)
      chmodSync(askpassPath, 0o700)
      env.GIT_ASKPASS = askpassPath
      env.SITEIO_GIT_TOKEN = token
    }

    try {
      const result = spawnSync({
        cmd: ["git", "clone", "--depth", "1", "--branch", branch, url, targetDir],
        stdout: "pipe",
        stderr: "pipe",
        env,
      })

      if (result.exitCode !== 0) {
        const stderr = redactToken(result.stderr.toString(), token)
        if (stderr.includes("not found") || stderr.includes("does not exist")) {
          throw new SiteioError(`Branch '${branch}' not found in repository`)
        }
        if (
          stderr.includes("Authentication failed") ||
          stderr.includes("could not read Username") ||
          stderr.includes("could not read Password")
        ) {
          throw new SiteioError(
            token
              ? `Authentication failed for repository — check the git token`
              : `Authentication required for repository — supply a token with --git-token`
          )
        }
        if (stderr.includes("Repository not found") || stderr.includes("not appear to be a git repository")) {
          throw new SiteioError(`Repository not found: ${url}`)
        }
        throw new SiteioError(`Failed to clone repository: ${stderr}`)
      }
    } finally {
      if (askpassDir && existsSync(askpassDir)) {
        rmSync(askpassDir, { recursive: true, force: true })
      }
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
