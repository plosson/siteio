import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { AgentServer } from "../../lib/agent/server.ts"
import { mkdirSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { zipSync } from "fflate"
import type { ApiResponse, SiteInfo } from "../../types.ts"

// Disable TLS certificate verification for self-signed certs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"

// Increase default timeout for Docker operations
setDefaultTimeout(60000)

/**
 * Docker Integration Tests
 *
 * These tests use REAL Docker containers and Traefik routing.
 * Static sites are served by a single shared nginx container.
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

function createTestZip(content: string = "<html><body>Hello from Docker!</body></html>"): Uint8Array {
  return zipSync({
    "index.html": new TextEncoder().encode(content),
  })
}

function cleanupTestContainers(): void {
  // Remove any leftover test containers from previous runs
  const listResult = Bun.spawnSync({
    cmd: ["docker", "ps", "-a", "--filter", "name=siteio-", "--format", "{{.Names}}"],
    stdout: "pipe",
  })
  const containers = listResult.stdout.toString().trim().split("\n").filter(Boolean)
  for (const name of containers) {
    Bun.spawnSync({ cmd: ["docker", "rm", "-f", name], stdout: "pipe", stderr: "pipe" })
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

async function waitForSite(port: number, host: string, timeoutMs = 15000): Promise<boolean> {
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

describe("Integration: Docker", () => {
  let server: AgentServer
  let baseUrl: string
  let dockerAvailable = false

  beforeAll(async () => {
    // Check if Docker is available
    dockerAvailable = isDockerAvailable()

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

    // Start AgentServer with real Traefik and shared nginx
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

    // Stop server (this also stops Traefik and nginx)
    server?.stop()

    // Clean up any remaining containers
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

  it("should deploy static site and route through Traefik to shared nginx", async () => {
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

    const { data: siteInfo } = (await deployRes.json()) as ApiResponse<SiteInfo>
    expect(siteInfo?.subdomain).toBe(siteName)
    expect(siteInfo?.url).toBe(`https://${siteName}.${TEST_DOMAIN}`)

    // Wait for Traefik to pick up the new route
    const siteReady = await waitForSite(TEST_HTTPS_PORT, `${siteName}.${TEST_DOMAIN}`)
    expect(siteReady).toBe(true)

    // Make request through Traefik with Host header
    const siteRes = await fetch(`https://localhost:${TEST_HTTPS_PORT}/`, {
      headers: { Host: `${siteName}.${TEST_DOMAIN}` },
    })
    expect(siteRes.ok).toBe(true)

    const html = await siteRes.text()
    expect(html).toContain("Integration Test Site")
  })

  it("should serve different content for different sites from shared nginx", async () => {
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

    // Wait for routes to be available
    await waitForSite(TEST_HTTPS_PORT, `${site1}.${TEST_DOMAIN}`)
    await waitForSite(TEST_HTTPS_PORT, `${site2}.${TEST_DOMAIN}`)

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

  it("should remove route when site is undeployed", async () => {
    if (!dockerAvailable) return

    const siteName = "to-undeploy"

    // Deploy
    const zipData = createTestZip()
    await fetch(`${baseUrl}/sites/${siteName}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", "X-API-Key": TEST_API_KEY },
      body: zipData,
    })

    // Wait for route to be available
    await waitForSite(TEST_HTTPS_PORT, `${siteName}.${TEST_DOMAIN}`)

    // Verify site is accessible
    const beforeRes = await fetch(`https://localhost:${TEST_HTTPS_PORT}/`, {
      headers: { Host: `${siteName}.${TEST_DOMAIN}` },
    })
    expect(beforeRes.ok).toBe(true)

    // Undeploy
    const deleteRes = await fetch(`${baseUrl}/sites/${siteName}`, {
      method: "DELETE",
      headers: { "X-API-Key": TEST_API_KEY },
    })
    expect(deleteRes.ok).toBe(true)

    // Wait for Traefik to update routes
    await new Promise((r) => setTimeout(r, 2000))

    // Site should no longer be accessible (404 from Traefik)
    const afterRes = await fetch(`https://localhost:${TEST_HTTPS_PORT}/`, {
      headers: { Host: `${siteName}.${TEST_DOMAIN}` },
    })
    expect(afterRes.status).toBe(404)
  })

  it("should update content on redeploy without container restart", async () => {
    if (!dockerAvailable) return

    const siteName = "redeploy-test"

    // Initial deploy
    const zip1 = createTestZip("<html><body>Version 1</body></html>")
    await fetch(`${baseUrl}/sites/${siteName}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", "X-API-Key": TEST_API_KEY },
      body: zip1,
    })

    await waitForSite(TEST_HTTPS_PORT, `${siteName}.${TEST_DOMAIN}`)

    // Verify initial content
    const res1 = await fetch(`https://localhost:${TEST_HTTPS_PORT}/`, {
      headers: { Host: `${siteName}.${TEST_DOMAIN}` },
    })
    expect(await res1.text()).toContain("Version 1")

    // Redeploy with new content
    const zip2 = createTestZip("<html><body>Version 2</body></html>")
    await fetch(`${baseUrl}/sites/${siteName}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", "X-API-Key": TEST_API_KEY },
      body: zip2,
    })

    // Small delay for files to be written
    await new Promise((r) => setTimeout(r, 1000))

    // New content should be served immediately (no container restart needed)
    const res2 = await fetch(`https://localhost:${TEST_HTTPS_PORT}/`, {
      headers: { Host: `${siteName}.${TEST_DOMAIN}` },
    })
    expect(await res2.text()).toContain("Version 2")
  })

  it("should list deployed sites", async () => {
    if (!dockerAvailable) return

    // List sites
    const listRes = await fetch(`${baseUrl}/sites`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    expect(listRes.ok).toBe(true)

    const { data: sites } = (await listRes.json()) as ApiResponse<SiteInfo[]>
    expect(Array.isArray(sites)).toBe(true)
    // Should have sites from previous tests
    expect(sites!.length).toBeGreaterThan(0)
  })
})
