import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { GitManager, cloneErrorMessage } from "../../lib/agent/git"

describe("cloneErrorMessage", () => {
  const opts = { branch: "main", url: "https://github.com/u/private.git", hasToken: true }

  test("private repo with no access is NOT mislabeled as a missing branch", () => {
    // GitHub returns "Repository not found" for private repos the token can't read.
    const stderr = "remote: Repository not found.\nfatal: repository 'https://github.com/u/private.git/' not found"
    const msg = cloneErrorMessage(stderr, opts)
    expect(msg).toContain("Repository not found")
    expect(msg).not.toContain("Branch")
  })

  test("a genuinely missing branch is reported as a branch error", () => {
    const stderr = "fatal: Remote branch main not found in upstream origin"
    expect(cloneErrorMessage(stderr, opts)).toBe("Branch 'main' not found in repository")
  })

  test("missing credentials (no token) asks for a token", () => {
    const stderr = "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
    expect(cloneErrorMessage(stderr, { ...opts, hasToken: false })).toContain("supply a token")
  })

  test("bad credentials (with token) reports an auth failure", () => {
    const stderr = "remote: Invalid username or password.\nfatal: Authentication failed for 'https://...'"
    expect(cloneErrorMessage(stderr, opts)).toContain("Authentication failed")
  })

  test("unrecognized errors fall through to a generic message", () => {
    expect(cloneErrorMessage("fatal: unable to access: timeout", opts)).toContain("Failed to clone repository")
  })
})

describe("GitManager", () => {
  let tempDir: string
  let git: GitManager

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "siteio-git-test-"))
    git = new GitManager(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe("repoPath", () => {
    test("returns correct path for app", () => {
      const path = git.repoPath("myapp")
      expect(path).toBe(join(tempDir, "repos", "myapp"))
    })
  })

  describe("exists", () => {
    test("returns false for non-existent repo", () => {
      expect(git.exists("nonexistent")).toBe(false)
    })
  })

  describe("clone", () => {
    test("clones a public repository", async () => {
      // Use a small, stable public repo for testing
      await git.clone("test-clone", "https://github.com/octocat/Hello-World.git", "master")

      expect(git.exists("test-clone")).toBe(true)

      const repoPath = git.repoPath("test-clone")
      expect(existsSync(join(repoPath, ".git"))).toBe(true)
      expect(existsSync(join(repoPath, "README"))).toBe(true)
    }, 15000)

    test("throws error for non-existent repository", async () => {
      await expect(
        git.clone("test-fail", "https://github.com/nonexistent/repo-that-does-not-exist-12345.git", "main")
      ).rejects.toThrow()
    }, 15000)

    test("throws error for non-existent branch", async () => {
      await expect(
        git.clone("test-branch-fail", "https://github.com/octocat/Hello-World.git", "nonexistent-branch-xyz")
      ).rejects.toThrow("Branch")
    }, 15000)

    test("replaces existing repo on re-clone", async () => {
      // Clone first
      await git.clone("test-replace", "https://github.com/octocat/Hello-World.git", "master")

      const hash1 = await git.getCommitHash("test-replace")

      // Clone again (should replace)
      await git.clone("test-replace", "https://github.com/octocat/Hello-World.git", "master")

      const hash2 = await git.getCommitHash("test-replace")

      // Should have the same commit hash (same repo)
      expect(hash1).toBe(hash2)
    }, 30000)
  })

  describe("getCommitHash", () => {
    test("returns commit hash for cloned repo", async () => {
      await git.clone("test-hash", "https://github.com/octocat/Hello-World.git", "master")

      const hash = await git.getCommitHash("test-hash")

      // Commit hash should be 40 characters
      expect(hash).toMatch(/^[a-f0-9]{40}$/)
    }, 15000)

    test("throws error for non-existent repo", async () => {
      await expect(git.getCommitHash("nonexistent")).rejects.toThrow()
    })
  })

  describe("remove", () => {
    test("removes cloned repository", async () => {
      await git.clone("test-remove", "https://github.com/octocat/Hello-World.git", "master")
      expect(git.exists("test-remove")).toBe(true)

      await git.remove("test-remove")
      expect(git.exists("test-remove")).toBe(false)
    }, 15000)

    test("does not throw for non-existent repo", async () => {
      await expect(git.remove("nonexistent")).resolves.toBeUndefined()
    })
  })
})
