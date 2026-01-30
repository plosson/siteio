import { spawnSync } from "bun"
import { existsSync, rmSync } from "fs"
import { join } from "path"
import { SiteioError } from "../../utils/errors"

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
  async clone(appName: string, url: string, branch: string): Promise<void> {
    const targetDir = this.repoPath(appName)

    // Remove existing repo if present
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true })
    }

    const result = spawnSync({
      cmd: ["git", "clone", "--depth", "1", "--branch", branch, url, targetDir],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString()
      if (stderr.includes("not found") || stderr.includes("does not exist")) {
        throw new SiteioError(`Branch '${branch}' not found in repository`)
      }
      if (stderr.includes("Repository not found") || stderr.includes("not appear to be a git repository")) {
        throw new SiteioError(`Repository not found: ${url}`)
      }
      throw new SiteioError(`Failed to clone repository: ${stderr}`)
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
