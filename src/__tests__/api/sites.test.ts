import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { SiteioClient } from "../../lib/client.ts"
import type { AgentConfig, ApiResponse, SiteInfo } from "../../types.ts"

// Helper to parse JSON responses with proper typing
async function parseJson<T>(response: Response): Promise<ApiResponse<T>> {
  return response.json() as Promise<ApiResponse<T>>
}

const TEST_PORT = 4567
const TEST_API_KEY = "test-api-key-12345"
const TEST_DOMAIN = "test.local"

describe("API: Sites", () => {
  let server: AgentServer
  let dataDir: string
  let testSiteDir: string

  beforeAll(async () => {
    // Create temp directories
    dataDir = mkdtempSync(join(tmpdir(), "siteio-test-data-"))
    testSiteDir = mkdtempSync(join(tmpdir(), "siteio-test-site-"))

    // Create a test site with HTML files
    writeFileSync(join(testSiteDir, "index.html"), "<html><body><h1>Hello World</h1></body></html>")
    writeFileSync(join(testSiteDir, "about.html"), "<html><body><h1>About</h1></body></html>")
    mkdirSync(join(testSiteDir, "css"))
    writeFileSync(join(testSiteDir, "css", "style.css"), "body { color: red; }")

    // Start server
    const config: AgentConfig = {
      apiKey: TEST_API_KEY,
      dataDir,
      domain: TEST_DOMAIN,
      maxUploadSize: 50 * 1024 * 1024,
      httpPort: 80,
      httpsPort: 443,
      skipTraefik: true,
      port: TEST_PORT,
    }

    server = new AgentServer(config)
    await server.start()
  })

  afterAll(() => {
    server.stop()
    // Cleanup temp directories
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true })
    }
    if (existsSync(testSiteDir)) {
      rmSync(testSiteDir, { recursive: true })
    }
  })

  describe("Health endpoint", () => {
    test("should return ok without auth", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/health`)
      expect(response.ok).toBe(true)
      const data = await parseJson<{ status: string }>(response)
      expect(data.success).toBe(true)
      expect(data.data?.status).toBe("ok")
    })
  })

  describe("Authentication", () => {
    test("should reject requests without API key", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/sites`)
      expect(response.status).toBe(401)
    })

    test("should reject requests with wrong API key", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/sites`, {
        headers: { "X-API-Key": "wrong-key" },
      })
      expect(response.status).toBe(401)
    })

    test("should accept requests with correct API key", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/sites`, {
        headers: { "X-API-Key": TEST_API_KEY },
      })
      expect(response.ok).toBe(true)
    })
  })

  describe("Sites API", () => {
    const subdomain = "mysite"

    test("should list empty sites initially", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/sites`, {
        headers: { "X-API-Key": TEST_API_KEY },
      })
      expect(response.ok).toBe(true)
      const data = await parseJson<SiteInfo[]>(response)
      expect(data.success).toBe(true)
      expect(data.data).toEqual([])
    })

    test("should deploy a site", async () => {
      // Create zip from test site
      const files: Record<string, Uint8Array> = {
        "index.html": new TextEncoder().encode("<html><body><h1>Hello World</h1></body></html>"),
        "about.html": new TextEncoder().encode("<html><body><h1>About</h1></body></html>"),
        "css/style.css": new TextEncoder().encode("body { color: red; }"),
      }
      const zipData = zipSync(files, { level: 6 })

      const response = await fetch(`http://localhost:${TEST_PORT}/sites/${subdomain}`, {
        method: "POST",
        headers: {
          "X-API-Key": TEST_API_KEY,
          "Content-Type": "application/zip",
          "Content-Length": String(zipData.length),
        },
        body: zipData,
      })

      expect(response.ok).toBe(true)
      const data = await parseJson<SiteInfo>(response)
      expect(data.success).toBe(true)
      expect(data.data?.subdomain).toBe(subdomain)
      expect(data.data?.url).toBe(`https://${subdomain}.${TEST_DOMAIN}`)
      expect(data.data?.size).toBeGreaterThan(0)
      expect(data.data?.deployedAt).toBeDefined()
    })

    test("should list deployed site", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/sites`, {
        headers: { "X-API-Key": TEST_API_KEY },
      })
      expect(response.ok).toBe(true)
      const data = await parseJson<SiteInfo[]>(response)
      expect(data.success).toBe(true)
      expect(data.data?.length).toBe(1)
      expect(data.data?.[0]?.subdomain).toBe(subdomain)
    })

    test("should reject reserved subdomain 'api'", async () => {
      const zipData = zipSync({ "index.html": new TextEncoder().encode("test") })

      const response = await fetch(`http://localhost:${TEST_PORT}/sites/api`, {
        method: "POST",
        headers: {
          "X-API-Key": TEST_API_KEY,
          "Content-Type": "application/zip",
        },
        body: zipData,
      })

      expect(response.status).toBe(400)
      const data = await parseJson<null>(response)
      expect(data.error).toContain("reserved")
    })

    test("should reject invalid subdomain", async () => {
      const zipData = zipSync({ "index.html": new TextEncoder().encode("test") })

      const response = await fetch(`http://localhost:${TEST_PORT}/sites/INVALID_NAME`, {
        method: "POST",
        headers: {
          "X-API-Key": TEST_API_KEY,
          "Content-Type": "application/zip",
        },
        body: zipData,
      })

      expect(response.status).toBe(404) // Route doesn't match because of uppercase
    })

    test("should reject non-zip content type", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/sites/testsite`, {
        method: "POST",
        headers: {
          "X-API-Key": TEST_API_KEY,
          "Content-Type": "application/json",
        },
        body: "{}",
      })

      expect(response.status).toBe(400)
      const data = await parseJson<null>(response)
      expect(data.error).toContain("application/zip")
    })

    test("should redeploy and replace existing site", async () => {
      // Deploy new content
      const files: Record<string, Uint8Array> = {
        "index.html": new TextEncoder().encode("<html><body><h1>Updated!</h1></body></html>"),
      }
      const zipData = zipSync(files, { level: 6 })

      const response = await fetch(`http://localhost:${TEST_PORT}/sites/${subdomain}`, {
        method: "POST",
        headers: {
          "X-API-Key": TEST_API_KEY,
          "Content-Type": "application/zip",
        },
        body: zipData,
      })

      expect(response.ok).toBe(true)
      const data = await parseJson<SiteInfo>(response)
      expect(data.success).toBe(true)

      // Verify still only one site
      const listResponse = await fetch(`http://localhost:${TEST_PORT}/sites`, {
        headers: { "X-API-Key": TEST_API_KEY },
      })
      const listData = await parseJson<SiteInfo[]>(listResponse)
      expect(listData.data?.length).toBe(1)
    })

    test("should undeploy a site", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/sites/${subdomain}`, {
        method: "DELETE",
        headers: { "X-API-Key": TEST_API_KEY },
      })

      expect(response.ok).toBe(true)
      const data = await parseJson<null>(response)
      expect(data.success).toBe(true)
    })

    test("should return 404 for non-existent site undeploy", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/sites/nonexistent`, {
        method: "DELETE",
        headers: { "X-API-Key": TEST_API_KEY },
      })

      expect(response.status).toBe(404)
    })

    test("should list empty sites after undeploy", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/sites`, {
        headers: { "X-API-Key": TEST_API_KEY },
      })
      expect(response.ok).toBe(true)
      const data = await parseJson<SiteInfo[]>(response)
      expect(data.data).toEqual([])
    })
  })

  describe("Site OAuth API", () => {
    // These tests require OAuth to be configured on the server
    // Since the main server doesn't have OAuth enabled, we'll test the rejection case

    test("should reject setting OAuth when not configured on server", async () => {
      // First deploy a site
      const files: Record<string, Uint8Array> = {
        "index.html": new TextEncoder().encode("<html><body>OAuth Test</body></html>"),
      }
      const zipData = zipSync(files, { level: 6 })
      await fetch(`http://localhost:${TEST_PORT}/sites/oauth-test`, {
        method: "POST",
        headers: {
          "X-API-Key": TEST_API_KEY,
          "Content-Type": "application/zip",
        },
        body: zipData,
      })

      // Try to set OAuth - should fail because OAuth is not configured
      const response = await fetch(`http://localhost:${TEST_PORT}/sites/oauth-test/auth`, {
        method: "PATCH",
        headers: {
          "X-API-Key": TEST_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ allowedEmails: ["test@example.com"] }),
      })

      expect(response.status).toBe(400)
      const data = await parseJson<null>(response)
      expect(data.error).toContain("not configured")

      // Cleanup
      await fetch(`http://localhost:${TEST_PORT}/sites/oauth-test`, {
        method: "DELETE",
        headers: { "X-API-Key": TEST_API_KEY },
      })
    })

    test("should return 404 when setting OAuth on non-existent site", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/sites/nonexistent/auth`, {
        method: "PATCH",
        headers: {
          "X-API-Key": TEST_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ allowedEmails: ["test@example.com"] }),
      })

      expect(response.status).toBe(404)
    })

    test("should require allowedEmails, allowedDomain, allowedGroups, or remove", async () => {
      // Deploy a site first
      const files: Record<string, Uint8Array> = {
        "index.html": new TextEncoder().encode("<html><body>Test</body></html>"),
      }
      const zipData = zipSync(files, { level: 6 })
      await fetch(`http://localhost:${TEST_PORT}/sites/oauth-empty`, {
        method: "POST",
        headers: {
          "X-API-Key": TEST_API_KEY,
          "Content-Type": "application/zip",
        },
        body: zipData,
      })

      // Try to set OAuth with empty body
      const response = await fetch(`http://localhost:${TEST_PORT}/sites/oauth-empty/auth`, {
        method: "PATCH",
        headers: {
          "X-API-Key": TEST_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(400)
      const data = await parseJson<null>(response)
      expect(data.error).toContain("Provide")

      // Cleanup
      await fetch(`http://localhost:${TEST_PORT}/sites/oauth-empty`, {
        method: "DELETE",
        headers: { "X-API-Key": TEST_API_KEY },
      })
    })
  })

  describe("SiteioClient", () => {
    test("should work with the client library", async () => {
      const client = new SiteioClient({
        apiUrl: `http://localhost:${TEST_PORT}`,
        apiKey: TEST_API_KEY,
      })

      // List (empty)
      const sitesBefore = await client.listSites()
      expect(sitesBefore).toEqual([])

      // Deploy
      const files: Record<string, Uint8Array> = {
        "index.html": new TextEncoder().encode("<html><body>Client Test</body></html>"),
      }
      const zipData = zipSync(files)
      const deployed = await client.deploySite("clienttest", zipData)
      expect(deployed.subdomain).toBe("clienttest")

      // List (has one)
      const sitesAfter = await client.listSites()
      expect(sitesAfter.length).toBe(1)

      // Undeploy
      await client.undeploySite("clienttest")

      // List (empty again)
      const sitesFinal = await client.listSites()
      expect(sitesFinal).toEqual([])
    })
  })
})
