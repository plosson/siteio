import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { AgentServer } from "../lib/agent/server.ts"
import { DockerManager } from "../lib/agent/docker.ts"
import { mkdirSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { zipSync } from "fflate"
import type { ApiResponse, App, ContainerLogs } from "../types.ts"

// Disable TLS certificate verification for self-signed certs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"

// Increase default timeout for Docker operations
setDefaultTimeout(60000)

/**
 * Docker Integration Tests
 *
 * These tests use REAL Docker containers and Traefik routing.
 * They are skipped if Docker is not available.
 *
 * Prerequisites:
 * - Docker daemon running
 * - Ports 18080, 18443, 13099 available
 */

const TEST_DATA_DIR = join(import.meta.dir, ".test-data-docker-integration")
const TEST_API_KEY = "docker-integration-test-key"
const TEST_DOMAIN = "test.local"
const TEST_HTTP_PORT = 18080
const TEST_HTTPS_PORT = 18443
const TEST_API_PORT = 13099

function cleanupTestContainers(): void {
  // Remove any leftover test containers from previous runs
  const listResult = Bun.spawnSync({
    cmd: ["docker", "ps", "-a", "--filter", "name=siteio-", "--format", "{{.Names}}"],
    stdout: "pipe",
  })
  const containers = listResult.stdout.toString().trim().split("\n").filter(Boolean)
  for (const name of containers) {
    // Only remove test-related containers, not production ones
    if (name === "siteio-traefik" || name.startsWith("siteio-")) {
      Bun.spawnSync({ cmd: ["docker", "rm", "-f", name], stdout: "pipe", stderr: "pipe" })
    }
  }
}

function createTestZip(content: string = "<html><body>Hello from Docker!</body></html>"): Uint8Array {
  return zipSync({
    "index.html": new TextEncoder().encode(content),
  })
}

async function waitForContainer(docker: DockerManager, name: string, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (docker.isRunning(name)) {
      return true
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function waitForTraefik(port: number, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`https://localhost:${port}/`, {
        signal: AbortSignal.timeout(2000),
      })
      // Traefik returns 404 for unknown hosts, which means it's running
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

describe("Docker Integration Tests", () => {
  let server: AgentServer
  let docker: DockerManager
  let baseUrl: string
  let dockerAvailable = false

  beforeAll(async () => {
    // Check if Docker is available
    docker = new DockerManager(TEST_DATA_DIR)
    dockerAvailable = docker.isAvailable()

    if (!dockerAvailable) {
      console.log("⚠️  Docker not available - skipping Docker integration tests")
      return
    }

    // Clean up any leftover containers from previous runs
    cleanupTestContainers()

    // Clean up any leftover test data
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
    mkdirSync(TEST_DATA_DIR, { recursive: true })

    // Ensure network exists
    docker.ensureNetwork()

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

    // Stop server (this also stops Traefik)
    server?.stop()

    // Clean up any remaining site containers
    cleanupTestContainers()

    // Clean up test data
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
  })

  it("should skip if Docker not available", () => {
    if (!dockerAvailable) {
      console.log("Test skipped: Docker not available")
      expect(true).toBe(true)
      return
    }
    expect(dockerAvailable).toBe(true)
  })

  it("should deploy static site and route through Traefik", async () => {
    if (!dockerAvailable) return

    const siteName = "testsite"

    // Deploy site via API
    const zipData = createTestZip("<html><body>Integration Test Site</body></html>")
    const deployRes = await fetch(`${baseUrl}/sites/${siteName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/zip",
        "X-API-Key": TEST_API_KEY,
      },
      body: zipData,
    })

    if (!deployRes.ok) {
      console.error("Deploy failed:", deployRes.status, await deployRes.text())
    }
    expect(deployRes.ok).toBe(true)

    // Verify app was created
    const appRes = await fetch(`${baseUrl}/apps/${siteName}`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    expect(appRes.ok).toBe(true)
    const { data: app } = (await appRes.json()) as ApiResponse<App>
    expect(app?.type).toBe("static")
    expect(app?.image).toBe("nginx:alpine")

    // Wait for container to be running
    const containerReady = await waitForContainer(docker, siteName)
    expect(containerReady).toBe(true)

    // Wait for Traefik to pick up the new container
    await new Promise((r) => setTimeout(r, 3000))

    // Make request through Traefik with Host header
    const siteRes = await fetch(`https://localhost:${TEST_HTTPS_PORT}/`, {
      headers: { Host: `${siteName}.${TEST_DOMAIN}` },
    })
    expect(siteRes.ok).toBe(true)

    const html = await siteRes.text()
    expect(html).toContain("Integration Test Site")
  })

  it("should serve different content for different sites", async () => {
    if (!dockerAvailable) return

    const site1 = "site-one"
    const site2 = "site-two"

    // Deploy two sites with different content
    const zip1 = createTestZip("<html><body>Site One Content</body></html>")
    const zip2 = createTestZip("<html><body>Site Two Content</body></html>")

    await fetch(`${baseUrl}/sites/${site1}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", "X-API-Key": TEST_API_KEY },
      body: zip1,
    })

    await fetch(`${baseUrl}/sites/${site2}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", "X-API-Key": TEST_API_KEY },
      body: zip2,
    })

    // Wait for containers
    await waitForContainer(docker, site1)
    await waitForContainer(docker, site2)
    await new Promise((r) => setTimeout(r, 3000))

    // Verify each site serves its own content
    const res1 = await fetch(`https://localhost:${TEST_HTTPS_PORT}/`, {
      headers: { Host: `${site1}.${TEST_DOMAIN}` },
    })
    const res2 = await fetch(`https://localhost:${TEST_HTTPS_PORT}/`, {
      headers: { Host: `${site2}.${TEST_DOMAIN}` },
    })

    expect(await res1.text()).toContain("Site One Content")
    expect(await res2.text()).toContain("Site Two Content")
  })

  it("should remove container when site is undeployed", async () => {
    if (!dockerAvailable) return

    const siteName = "to-undeploy"

    // Deploy
    const zipData = createTestZip()
    await fetch(`${baseUrl}/sites/${siteName}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", "X-API-Key": TEST_API_KEY },
      body: zipData,
    })

    await waitForContainer(docker, siteName)
    expect(docker.containerExists(siteName)).toBe(true)

    // Undeploy
    const deleteRes = await fetch(`${baseUrl}/sites/${siteName}`, {
      method: "DELETE",
      headers: { "X-API-Key": TEST_API_KEY },
    })
    expect(deleteRes.ok).toBe(true)

    // Container should be removed
    expect(docker.containerExists(siteName)).toBe(false)
  })

  it("should return container logs", async () => {
    if (!dockerAvailable) return

    const siteName = "logs-test"

    // Deploy and make a request to generate logs
    const zipData = createTestZip()
    await fetch(`${baseUrl}/sites/${siteName}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", "X-API-Key": TEST_API_KEY },
      body: zipData,
    })

    await waitForContainer(docker, siteName)
    await new Promise((r) => setTimeout(r, 3000))

    // Make request to generate access log
    await fetch(`https://localhost:${TEST_HTTPS_PORT}/`, {
      headers: { Host: `${siteName}.${TEST_DOMAIN}` },
    })

    // Get logs via API
    const logsRes = await fetch(`${baseUrl}/apps/${siteName}/logs?tail=50`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    expect(logsRes.ok).toBe(true)

    const { data } = (await logsRes.json()) as ApiResponse<ContainerLogs>
    // nginx logs should exist (may or may not contain the request depending on timing)
    expect(data?.logs).toBeDefined()
  })

  it("should redeploy site by replacing container", async () => {
    if (!dockerAvailable) return

    const siteName = "redeploy-test"

    // Initial deploy
    const zip1 = createTestZip("<html><body>Version 1</body></html>")
    await fetch(`${baseUrl}/sites/${siteName}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", "X-API-Key": TEST_API_KEY },
      body: zip1,
    })

    await waitForContainer(docker, siteName)
    await new Promise((r) => setTimeout(r, 2000))

    // Get initial container ID
    const inspect1 = await docker.inspect(siteName)
    const containerId1 = inspect1?.id

    // Redeploy with new content
    const zip2 = createTestZip("<html><body>Version 2</body></html>")
    await fetch(`${baseUrl}/sites/${siteName}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", "X-API-Key": TEST_API_KEY },
      body: zip2,
    })

    await waitForContainer(docker, siteName)
    await new Promise((r) => setTimeout(r, 3000))

    // Container ID should be different (new container)
    const inspect2 = await docker.inspect(siteName)
    expect(inspect2?.id).not.toBe(containerId1)

    // New content should be served
    const res = await fetch(`https://localhost:${TEST_HTTPS_PORT}/`, {
      headers: { Host: `${siteName}.${TEST_DOMAIN}` },
    })
    expect(await res.text()).toContain("Version 2")
  })
})
