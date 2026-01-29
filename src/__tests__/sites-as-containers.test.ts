import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { AgentServer } from "../lib/agent/server.ts"
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs"
import { join } from "path"
import { zipSync } from "fflate"
import type { ApiResponse, App } from "../types.ts"

describe("Static Sites as Containers", () => {
  const TEST_DATA_DIR = join(import.meta.dir, ".test-data-sites-containers")
  const TEST_API_KEY = "test-api-key-sites"
  const TEST_DOMAIN = "test.siteio.me"
  let server: AgentServer
  let baseUrl: string

  beforeAll(async () => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
    mkdirSync(TEST_DATA_DIR, { recursive: true })

    // Create OAuth config so auth tests work
    const oauthConfig = {
      issuerUrl: "https://accounts.google.com",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      cookieSecret: "test-cookie-secret-32chars-long!",
      cookieDomain: TEST_DOMAIN,
    }
    writeFileSync(join(TEST_DATA_DIR, "oauth-config.json"), JSON.stringify(oauthConfig))

    server = new AgentServer({
      domain: TEST_DOMAIN,
      apiKey: TEST_API_KEY,
      dataDir: TEST_DATA_DIR,
      maxUploadSize: 10 * 1024 * 1024,
      skipTraefik: true,
      port: 3099,
      httpPort: 80,
      httpsPort: 443,
    })

    await server.start()
    baseUrl = "http://localhost:3099"
  })

  afterAll(() => {
    server.stop()
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
  })

  beforeEach(() => {
    for (const dir of ["apps", "sites", "metadata"]) {
      const path = join(TEST_DATA_DIR, dir)
      if (existsSync(path)) {
        rmSync(path, { recursive: true })
      }
      mkdirSync(path, { recursive: true })
    }
  })

  function createTestZip(): Uint8Array {
    return zipSync({
      "index.html": new TextEncoder().encode("<html><body>Test</body></html>"),
    })
  }

  it("creates app record when deploying static site", async () => {
    const zipData = createTestZip()

    const deployRes = await fetch(`${baseUrl}/sites/testsite`, {
      method: "POST",
      headers: {
        "Content-Type": "application/zip",
        "X-API-Key": TEST_API_KEY,
      },
      body: zipData,
    })
    expect(deployRes.ok).toBe(true)

    const appRes = await fetch(`${baseUrl}/apps/testsite`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    expect(appRes.ok).toBe(true)

    const { data: app } = (await appRes.json()) as ApiResponse<App>
    expect(app?.name).toBe("testsite")
    expect(app?.type).toBe("static")
    expect(app?.image).toBe("nginx:alpine")
    expect(app?.internalPort).toBe(80)
  })

  it("sets domain for static site app", async () => {
    const zipData = createTestZip()

    const deployRes = await fetch(`${baseUrl}/sites/domainsite`, {
      method: "POST",
      headers: {
        "Content-Type": "application/zip",
        "X-API-Key": TEST_API_KEY,
      },
      body: zipData,
    })
    expect(deployRes.ok).toBe(true)

    const appRes = await fetch(`${baseUrl}/apps/domainsite`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    const { data: app } = (await appRes.json()) as ApiResponse<App>
    expect(app?.domains).toContain(`domainsite.${TEST_DOMAIN}`)
  })

  it("redeploys by updating existing app", async () => {
    const zipData = createTestZip()

    await fetch(`${baseUrl}/sites/redeploysite`, {
      method: "POST",
      headers: {
        "Content-Type": "application/zip",
        "X-API-Key": TEST_API_KEY,
      },
      body: zipData,
    })

    let appRes = await fetch(`${baseUrl}/apps/redeploysite`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    const { data: app1 } = (await appRes.json()) as ApiResponse<App>
    const firstCreatedAt = app1?.createdAt
    const firstUpdatedAt = app1?.updatedAt

    // Wait a small amount to ensure timestamps differ
    await new Promise((resolve) => setTimeout(resolve, 10))

    await fetch(`${baseUrl}/sites/redeploysite`, {
      method: "POST",
      headers: {
        "Content-Type": "application/zip",
        "X-API-Key": TEST_API_KEY,
      },
      body: zipData,
    })

    appRes = await fetch(`${baseUrl}/apps/redeploysite`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    const { data: app2 } = (await appRes.json()) as ApiResponse<App>
    expect(app2?.createdAt).toBe(firstCreatedAt)
    expect(app2?.updatedAt).not.toBe(firstUpdatedAt)
  })

  it("removes app and container when undeploying", async () => {
    const zipData = createTestZip()

    // Deploy
    await fetch(`${baseUrl}/sites/todelete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/zip",
        "X-API-Key": TEST_API_KEY,
      },
      body: zipData,
    })

    // Verify app exists
    let appRes = await fetch(`${baseUrl}/apps/todelete`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    expect(appRes.ok).toBe(true)

    // Undeploy
    const deleteRes = await fetch(`${baseUrl}/sites/todelete`, {
      method: "DELETE",
      headers: { "X-API-Key": TEST_API_KEY },
    })
    expect(deleteRes.ok).toBe(true)

    // Verify app is gone
    appRes = await fetch(`${baseUrl}/apps/todelete`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    expect(appRes.status).toBe(404)
  })

  it("syncs OAuth changes to app record", async () => {
    const zipData = createTestZip()

    // Deploy without OAuth
    await fetch(`${baseUrl}/sites/authsync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/zip",
        "X-API-Key": TEST_API_KEY,
      },
      body: zipData,
    })

    // Add OAuth
    await fetch(`${baseUrl}/sites/authsync/auth`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        allowedEmails: ["new@example.com"],
      }),
    })

    // Check app has OAuth
    const appRes = await fetch(`${baseUrl}/apps/authsync`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    const { data: app } = (await appRes.json()) as ApiResponse<App>
    expect(app?.oauth?.allowedEmails).toContain("new@example.com")
  })

  it("removes OAuth from app record when removed from site", async () => {
    const zipData = createTestZip()

    // Deploy with OAuth
    await fetch(`${baseUrl}/sites/authremove`, {
      method: "POST",
      headers: {
        "Content-Type": "application/zip",
        "X-API-Key": TEST_API_KEY,
        "X-Site-OAuth-Emails": "user@example.com",
      },
      body: zipData,
    })

    // Remove OAuth
    await fetch(`${baseUrl}/sites/authremove/auth`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({ remove: true }),
    })

    // Check app has no OAuth
    const appRes = await fetch(`${baseUrl}/apps/authremove`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    const { data: app } = (await appRes.json()) as ApiResponse<App>
    expect(app?.oauth).toBeUndefined()
  })
})
