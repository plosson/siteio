import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import type { AgentConfig, ApiResponse, SiteInfo } from "../../types.ts"

async function parseJson<T>(response: Response): Promise<ApiResponse<T>> {
  return response.json() as Promise<ApiResponse<T>>
}

const TEST_PORT = 4572
const TEST_API_KEY = "test-api-key-storage"
const TEST_DOMAIN = "test.local"

function makeZip() {
  return zipSync({
    "index.html": new TextEncoder().encode("<html><head></head><body>Hello</body></html>"),
  })
}

async function deploySite(subdomain: string, persistentStorage = false) {
  const zipData = makeZip()
  const headers: Record<string, string> = {
    "X-API-Key": TEST_API_KEY,
    "Content-Type": "application/zip",
  }
  if (persistentStorage) {
    headers["X-Site-Persistent-Storage"] = "true"
  }
  return fetch(`http://localhost:${TEST_PORT}/sites/${subdomain}`, {
    method: "POST",
    headers,
    body: zipData,
  })
}

async function deleteSite(subdomain: string) {
  return fetch(`http://localhost:${TEST_PORT}/sites/${subdomain}`, {
    method: "DELETE",
    headers: { "X-API-Key": TEST_API_KEY },
  })
}

describe("API: Persistent Storage", () => {
  let server: AgentServer
  let dataDir: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-test-storage-"))

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
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true })
    }
  })

  describe("Deploy with --persistent-storage", () => {
    afterEach(async () => {
      await deleteSite("ps-deploy")
    })

    test("should deploy site with persistent storage enabled", async () => {
      const response = await deploySite("ps-deploy", true)
      expect(response.ok).toBe(true)
      const data = await parseJson<SiteInfo>(response)
      expect(data.data?.persistentStorage).toBe(true)
    })

    test("should deploy site without persistent storage by default", async () => {
      const response = await deploySite("ps-deploy", false)
      expect(response.ok).toBe(true)
      const data = await parseJson<SiteInfo>(response)
      expect(data.data?.persistentStorage).toBeUndefined()
    })

    test("should persist flag across redeploys", async () => {
      // Deploy with persistent storage
      await deploySite("ps-deploy", true)

      // Redeploy without the header
      const response = await deploySite("ps-deploy", false)
      expect(response.ok).toBe(true)
      const data = await parseJson<SiteInfo>(response)
      expect(data.data?.persistentStorage).toBe(true)
    })

    test("should show persistentStorage in site listing", async () => {
      await deploySite("ps-deploy", true)

      const response = await fetch(`http://localhost:${TEST_PORT}/sites`, {
        headers: { "X-API-Key": TEST_API_KEY },
      })
      const data = await parseJson<SiteInfo[]>(response)
      const site = data.data?.find((s) => s.subdomain === "ps-deploy")
      expect(site?.persistentStorage).toBe(true)
    })
  })

  describe("Storage toggle API", () => {
    beforeEach(async () => {
      await deploySite("ps-toggle")
    })

    afterEach(async () => {
      await deleteSite("ps-toggle")
    })

    test("should toggle persistent storage on", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/sites/ps-toggle/storage`, {
        method: "PATCH",
        headers: {
          "X-API-Key": TEST_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      })
      expect(response.ok).toBe(true)
      const data = await parseJson<{ persistentStorage: boolean }>(response)
      expect(data.data?.persistentStorage).toBe(true)
    })

    test("should toggle persistent storage off", async () => {
      // Enable first
      await fetch(`http://localhost:${TEST_PORT}/sites/ps-toggle/storage`, {
        method: "PATCH",
        headers: {
          "X-API-Key": TEST_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      })

      // Disable
      const response = await fetch(`http://localhost:${TEST_PORT}/sites/ps-toggle/storage`, {
        method: "PATCH",
        headers: {
          "X-API-Key": TEST_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      })
      expect(response.ok).toBe(true)
    })

    test("should return 404 for non-existent site", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/sites/nonexistent/storage`, {
        method: "PATCH",
        headers: {
          "X-API-Key": TEST_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      })
      expect(response.status).toBe(404)
    })

    test("should require API key auth", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/sites/ps-toggle/storage`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      })
      expect(response.status).toBe(401)
    })
  })

  describe("Storage data API (GET/PUT /__storage/)", () => {
    beforeEach(async () => {
      await deploySite("ps-data", true)
    })

    afterEach(async () => {
      await deleteSite("ps-data")
    })

    test("should return empty object for fresh site", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        headers: { "X-Site-Subdomain": "ps-data" },
      })
      expect(response.ok).toBe(true)
      const data = await response.json()
      expect(data).toEqual({})
    })

    test("should store and retrieve data", async () => {
      // PUT data
      const putResponse = await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        method: "PUT",
        headers: {
          "X-Site-Subdomain": "ps-data",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ key1: "value1", key2: "value2" }),
      })
      expect(putResponse.ok).toBe(true)

      // GET data
      const getResponse = await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        headers: { "X-Site-Subdomain": "ps-data" },
      })
      expect(getResponse.ok).toBe(true)
      const data = await getResponse.json()
      expect(data).toEqual({ key1: "value1", key2: "value2" })
    })

    test("should overwrite data on subsequent PUTs", async () => {
      await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        method: "PUT",
        headers: {
          "X-Site-Subdomain": "ps-data",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ old: "data" }),
      })

      await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        method: "PUT",
        headers: {
          "X-Site-Subdomain": "ps-data",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ new: "data" }),
      })

      const response = await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        headers: { "X-Site-Subdomain": "ps-data" },
      })
      const data = await response.json()
      expect(data).toEqual({ new: "data" })
    })

    test("should enforce 1MB size limit", async () => {
      const largeData: Record<string, string> = {}
      // Create a string just over 1MB
      largeData.big = "x".repeat(1024 * 1024 + 1)

      const response = await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        method: "PUT",
        headers: {
          "X-Site-Subdomain": "ps-data",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(largeData),
      })
      expect(response.status).toBe(413)
    })

    test("should return 404 when storage is not enabled", async () => {
      // Deploy a site without persistent storage
      await deploySite("ps-no-storage", false)

      const response = await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        headers: { "X-Site-Subdomain": "ps-no-storage" },
      })
      expect(response.status).toBe(404)

      await deleteSite("ps-no-storage")
    })

    test("should return 404 for unknown site", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        headers: { "X-Site-Subdomain": "nonexistent" },
      })
      expect(response.status).toBe(404)
    })
  })

  describe("Per-user storage with OAuth", () => {
    beforeEach(async () => {
      await deploySite("ps-oauth", true)
    })

    afterEach(async () => {
      await deleteSite("ps-oauth")
    })

    test("should isolate storage by user email", async () => {
      // Store data for user A
      await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        method: "PUT",
        headers: {
          "X-Site-Subdomain": "ps-oauth",
          "X-Auth-Request-Email": "alice@example.com",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user: "alice" }),
      })

      // Store data for user B
      await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        method: "PUT",
        headers: {
          "X-Site-Subdomain": "ps-oauth",
          "X-Auth-Request-Email": "bob@example.com",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user: "bob" }),
      })

      // Get data for user A
      const responseA = await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        headers: {
          "X-Site-Subdomain": "ps-oauth",
          "X-Auth-Request-Email": "alice@example.com",
        },
      })
      const dataA = await responseA.json()
      expect(dataA).toEqual({ user: "alice" })

      // Get data for user B
      const responseB = await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        headers: {
          "X-Site-Subdomain": "ps-oauth",
          "X-Auth-Request-Email": "bob@example.com",
        },
      })
      const dataB = await responseB.json()
      expect(dataB).toEqual({ user: "bob" })
    })

    test("should use anonymous storage when no email header", async () => {
      await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        method: "PUT",
        headers: {
          "X-Site-Subdomain": "ps-oauth",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ anonymous: "true" }),
      })

      const response = await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        headers: { "X-Site-Subdomain": "ps-oauth" },
      })
      const data = await response.json()
      expect(data).toEqual({ anonymous: "true" })
    })
  })

  describe("Site deletion cleanup", () => {
    test("should delete storage data when site is deleted", async () => {
      // Deploy with storage and add data
      await deploySite("ps-cleanup", true)
      await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        method: "PUT",
        headers: {
          "X-Site-Subdomain": "ps-cleanup",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ saved: "data" }),
      })

      // Delete site
      await deleteSite("ps-cleanup")

      // Verify storage directory is gone
      const storageDir = join(dataDir, "persistent-storage", "ps-cleanup")
      expect(existsSync(storageDir)).toBe(false)
    })
  })

  describe("Shim.js endpoint", () => {
    test("should serve shim.js with correct content-type", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/__storage/shim.js`)
      expect(response.ok).toBe(true)
      expect(response.headers.get("Content-Type")).toBe("application/javascript")
    })

    test("should return valid JavaScript", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/__storage/shim.js`)
      const text = await response.text()
      expect(text).toContain("XMLHttpRequest")
      expect(text).toContain("localStorage")
      expect(text).toContain("__storage")
    })
  })

  describe("Storage isolation between sites", () => {
    beforeEach(async () => {
      await deploySite("ps-site-a", true)
      await deploySite("ps-site-b", true)
    })

    afterEach(async () => {
      await deleteSite("ps-site-a")
      await deleteSite("ps-site-b")
    })

    test("should isolate storage between different sites", async () => {
      // Store data for site A
      await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        method: "PUT",
        headers: {
          "X-Site-Subdomain": "ps-site-a",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ site: "A" }),
      })

      // Store data for site B
      await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        method: "PUT",
        headers: {
          "X-Site-Subdomain": "ps-site-b",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ site: "B" }),
      })

      // Verify isolation
      const responseA = await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        headers: { "X-Site-Subdomain": "ps-site-a" },
      })
      expect(await responseA.json()).toEqual({ site: "A" })

      const responseB = await fetch(`http://localhost:${TEST_PORT}/__storage/`, {
        headers: { "X-Site-Subdomain": "ps-site-b" },
      })
      expect(await responseB.json()).toEqual({ site: "B" })
    })
  })
})
