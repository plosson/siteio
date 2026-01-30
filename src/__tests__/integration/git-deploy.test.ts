import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { AgentServer } from "../../lib/agent/server.ts"
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs"
import { join } from "path"
import type { ApiResponse, App } from "../../types.ts"

// Disable TLS certificate verification for self-signed certs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"

// Increase default timeout for Docker/Git operations
setDefaultTimeout(120000)

/**
 * Git Deployment Integration Tests
 *
 * These tests verify the complete git-based deployment flow:
 * 1. Clone a git repository
 * 2. Build Docker image from Dockerfile
 * 3. Run container and verify it's accessible
 *
 * Tests both root-level and context subdirectory builds.
 *
 * Prerequisites:
 * - Docker daemon running
 * - Network access to clone from GitHub
 * - Ports 19080, 19443, 14099 available
 */

const TEST_DATA_DIR = join(import.meta.dir, ".test-data-git-deploy")
const TEST_API_KEY = "git-deploy-integration-test-key"
const TEST_DOMAIN = "git-deploy-test.local"
const TEST_HTTP_PORT = 19080
const TEST_HTTPS_PORT = 19443
const TEST_API_PORT = 14099

// Use the siteio repo's examples/docker which has a simple Node.js server
const TEST_GIT_REPO = "https://github.com/plosson/siteio"
const TEST_GIT_CONTEXT = "examples/docker"
const TEST_APP_PORT = 3000

function cleanupTestContainers(): void {
  const listResult = Bun.spawnSync({
    cmd: ["docker", "ps", "-a", "--filter", "name=siteio-git-", "--format", "{{.Names}}"],
    stdout: "pipe",
  })
  const containers = listResult.stdout.toString().trim().split("\n").filter(Boolean)
  for (const name of containers) {
    Bun.spawnSync({ cmd: ["docker", "rm", "-f", name], stdout: "pipe", stderr: "pipe" })
  }

  // Also clean up test images
  const imageResult = Bun.spawnSync({
    cmd: ["docker", "images", "--filter", "reference=siteio-git-*", "--format", "{{.Repository}}:{{.Tag}}"],
    stdout: "pipe",
  })
  const images = imageResult.stdout.toString().trim().split("\n").filter(Boolean)
  for (const image of images) {
    Bun.spawnSync({ cmd: ["docker", "rmi", "-f", image], stdout: "pipe", stderr: "pipe" })
  }
}

function isDockerAvailable(): boolean {
  const result = Bun.spawnSync({ cmd: ["docker", "info"], stdout: "pipe", stderr: "pipe" })
  return result.exitCode === 0
}

async function waitForTraefik(port: number, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`https://localhost:${port}/`, {
        signal: AbortSignal.timeout(2000),
      })
      if (res.status === 404 || res.ok) {
        return true
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function waitForApp(port: number, host: string, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`https://localhost:${port}/`, {
        headers: { Host: host },
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) {
        return true
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

describe("Integration: Git Deploy", () => {
  let server: AgentServer
  let baseUrl: string
  let dockerAvailable = false

  beforeAll(async () => {
    dockerAvailable = isDockerAvailable()

    if (!dockerAvailable) {
      console.log("⚠️  Docker not available - skipping git deploy integration tests")
      return
    }

    // Clean up any leftover containers from previous runs
    cleanupTestContainers()

    // Clean up any leftover test data
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
    mkdirSync(TEST_DATA_DIR, { recursive: true })

    // Start AgentServer with real Traefik
    server = new AgentServer({
      domain: TEST_DOMAIN,
      apiKey: TEST_API_KEY,
      dataDir: TEST_DATA_DIR,
      maxUploadSize: 10 * 1024 * 1024,
      port: TEST_API_PORT,
      httpPort: TEST_HTTP_PORT,
      httpsPort: TEST_HTTPS_PORT,
    })

    await server.start()
    baseUrl = `http://localhost:${TEST_API_PORT}`

    // Wait for Traefik to be ready
    const traefikReady = await waitForTraefik(TEST_HTTPS_PORT)
    if (!traefikReady) {
      throw new Error("Traefik failed to start within timeout")
    }
  })

  afterAll(async () => {
    if (!dockerAvailable) return

    server?.stop()
    cleanupTestContainers()

    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
  })

  async function createApp(name: string, options: object): Promise<ApiResponse<App>> {
    const res = await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({ name, ...options }),
    })
    return res.json() as Promise<ApiResponse<App>>
  }

  async function deployApp(name: string, noCache = false): Promise<ApiResponse<App>> {
    const url = noCache ? `${baseUrl}/apps/${name}/deploy?noCache=true` : `${baseUrl}/apps/${name}/deploy`
    const res = await fetch(url, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY },
    })
    return res.json() as Promise<ApiResponse<App>>
  }

  async function deleteApp(name: string): Promise<void> {
    await fetch(`${baseUrl}/apps/${name}`, {
      method: "DELETE",
      headers: { "X-API-Key": TEST_API_KEY },
    })
  }

  it("should skip if Docker not available", () => {
    if (!dockerAvailable) {
      console.log("Test skipped: Docker not available")
      expect(true).toBe(true)
      return
    }
    expect(dockerAvailable).toBe(true)
  })

  it("should deploy app from git repo with context subdirectory", async () => {
    if (!dockerAvailable) return

    const appName = "git-context-test"

    // Create app with git source and context subdirectory
    const createResult = await createApp(appName, {
      git: {
        repoUrl: TEST_GIT_REPO,
        branch: "main",
        dockerfile: "Dockerfile",
        context: TEST_GIT_CONTEXT,
      },
      internalPort: TEST_APP_PORT,
    })

    expect(createResult.success).toBe(true)
    expect(createResult.data?.git?.context).toBe(TEST_GIT_CONTEXT)

    // Deploy - this clones, builds, and runs
    const deployResult = await deployApp(appName)

    expect(deployResult.success).toBe(true)
    expect(deployResult.data?.status).toBe("running")

    // Wait for app to be accessible through Traefik
    const appHost = `${appName}.${TEST_DOMAIN}`
    const appReady = await waitForApp(TEST_HTTPS_PORT, appHost)
    expect(appReady).toBe(true)

    // Verify the app responds correctly
    const appRes = await fetch(`https://localhost:${TEST_HTTPS_PORT}/`, {
      headers: { Host: appHost },
    })
    expect(appRes.ok).toBe(true)

    const body = await appRes.text()
    // The examples/docker server.js returns HTML page with status info
    expect(body).toContain("Container is running")

    // Cleanup
    await deleteApp(appName)
  })

  it("should fail gracefully when Dockerfile not found in context", async () => {
    if (!dockerAvailable) return

    const appName = "git-bad-context"

    // Create app with non-existent context
    const createResult = await createApp(appName, {
      git: {
        repoUrl: TEST_GIT_REPO,
        branch: "main",
        dockerfile: "Dockerfile",
        context: "non-existent-directory",
      },
      internalPort: 3000,
    })

    expect(createResult.success).toBe(true)

    // Deploy should fail because Dockerfile doesn't exist in that context
    const deployResult = await deployApp(appName)

    expect(deployResult.success).toBe(false)
    expect(deployResult.error).toContain("Dockerfile not found")

    // Cleanup
    await deleteApp(appName)
  })

  it("should rebuild app with --no-cache", async () => {
    if (!dockerAvailable) return

    const appName = "git-rebuild-test"

    // Create and deploy
    await createApp(appName, {
      git: {
        repoUrl: TEST_GIT_REPO,
        branch: "main",
        dockerfile: "Dockerfile",
        context: TEST_GIT_CONTEXT,
      },
      internalPort: TEST_APP_PORT,
    })

    const firstDeploy = await deployApp(appName)
    expect(firstDeploy.success).toBe(true)

    // Redeploy with no-cache
    const secondDeploy = await deployApp(appName, true)
    expect(secondDeploy.success).toBe(true)
    expect(secondDeploy.data?.status).toBe("running")

    // Cleanup
    await deleteApp(appName)
  })

  it("should store and return git build metadata", async () => {
    if (!dockerAvailable) return

    const appName = "git-metadata-test"

    await createApp(appName, {
      git: {
        repoUrl: TEST_GIT_REPO,
        branch: "main",
        dockerfile: "Dockerfile",
        context: TEST_GIT_CONTEXT,
      },
      internalPort: TEST_APP_PORT,
    })

    const deployResult = await deployApp(appName)
    expect(deployResult.success).toBe(true)

    // Check that git metadata is populated after build
    const infoRes = await fetch(`${baseUrl}/apps/${appName}`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    const { data: appInfo } = (await infoRes.json()) as ApiResponse<App>

    expect(appInfo?.commitHash).toBeDefined()
    expect(appInfo?.commitHash?.length).toBeGreaterThan(0)
    expect(appInfo?.lastBuildAt).toBeDefined()

    // Cleanup
    await deleteApp(appName)
  })
})
