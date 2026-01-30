import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import type { ApiResponse, SiteInfo } from "../../types.ts"

async function parseJson<T>(response: Response): Promise<ApiResponse<T>> {
  return response.json() as Promise<ApiResponse<T>>
}

const TEST_PORT = 4571
const TEST_API_KEY = "test-api-key-oauth"
const TEST_DOMAIN = "test.local"

describe("API: Sites OAuth", () => {
  let server: AgentServer
  const dataDir = join(import.meta.dir, ".test-data-sites-oauth")

  async function deploySite(subdomain: string): Promise<void> {
    const files: Record<string, Uint8Array> = {
      "index.html": new TextEncoder().encode("<html><body>Test</body></html>"),
    }
    const zipData = zipSync(files, { level: 6 })
    await fetch(`http://localhost:${TEST_PORT}/sites/${subdomain}`, {
      method: "POST",
      headers: {
        "X-API-Key": TEST_API_KEY,
        "Content-Type": "application/zip",
      },
      body: zipData,
    })
  }

  async function deleteSite(subdomain: string): Promise<void> {
    await fetch(`http://localhost:${TEST_PORT}/sites/${subdomain}`, {
      method: "DELETE",
      headers: { "X-API-Key": TEST_API_KEY },
    })
  }

  beforeAll(async () => {
    // Setup data directory
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true })
    }
    mkdirSync(dataDir, { recursive: true })

    // Create oauth-config.json to enable OAuth
    writeFileSync(
      join(dataDir, "oauth-config.json"),
      JSON.stringify({
        issuerUrl: "https://accounts.google.com",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        cookieSecret: "test-cookie-secret-32-chars-long!",
        cookieDomain: ".test.local",
      })
    )

    // Create groups for testing
    writeFileSync(
      join(dataDir, "groups.json"),
      JSON.stringify([
        { name: "admins", emails: ["admin@example.com"] },
        { name: "devs", emails: ["dev@example.com"] },
      ])
    )

    server = new AgentServer({
      apiKey: TEST_API_KEY,
      dataDir,
      domain: TEST_DOMAIN,
      maxUploadSize: 10 * 1024 * 1024,
      httpPort: 80,
      httpsPort: 443,
      skipTraefik: true,
      port: TEST_PORT,
    })

    await server.start()
  })

  afterAll(() => {
    server.stop()
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true })
    }
  })

  beforeEach(() => {
    // Clean up sites between tests
    const sitesDir = join(dataDir, "sites")
    const metadataDir = join(dataDir, "metadata")
    if (existsSync(sitesDir)) {
      rmSync(sitesDir, { recursive: true })
    }
    if (existsSync(metadataDir)) {
      rmSync(metadataDir, { recursive: true })
    }
    mkdirSync(sitesDir, { recursive: true })
    mkdirSync(metadataDir, { recursive: true })
  })

  test("should set OAuth with allowedEmails", async () => {
    await deploySite("email-site")

    const response = await fetch(`http://localhost:${TEST_PORT}/sites/email-site/auth`, {
      method: "PATCH",
      headers: {
        "X-API-Key": TEST_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ allowedEmails: ["user@example.com", "other@example.com"] }),
    })

    expect(response.ok).toBe(true)
    const data = await parseJson<{ message: string }>(response)
    expect(data.success).toBe(true)

    // Verify OAuth is set by listing sites
    const listRes = await fetch(`http://localhost:${TEST_PORT}/sites`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    const listData = await parseJson<SiteInfo[]>(listRes)
    const site = listData.data?.find((s) => s.subdomain === "email-site")
    expect(site?.oauth?.allowedEmails).toEqual(["user@example.com", "other@example.com"])
  })

  test("should set OAuth with allowedDomain", async () => {
    await deploySite("domain-site")

    const response = await fetch(`http://localhost:${TEST_PORT}/sites/domain-site/auth`, {
      method: "PATCH",
      headers: {
        "X-API-Key": TEST_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ allowedDomain: "company.com" }),
    })

    expect(response.ok).toBe(true)

    // Verify
    const listRes = await fetch(`http://localhost:${TEST_PORT}/sites`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    const listData = await parseJson<SiteInfo[]>(listRes)
    const site = listData.data?.find((s) => s.subdomain === "domain-site")
    expect(site?.oauth?.allowedDomain).toBe("company.com")
  })

  test("should set OAuth with allowedGroups", async () => {
    await deploySite("group-site")

    const response = await fetch(`http://localhost:${TEST_PORT}/sites/group-site/auth`, {
      method: "PATCH",
      headers: {
        "X-API-Key": TEST_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ allowedGroups: ["admins", "devs"] }),
    })

    expect(response.ok).toBe(true)

    // Verify
    const listRes = await fetch(`http://localhost:${TEST_PORT}/sites`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    const listData = await parseJson<SiteInfo[]>(listRes)
    const site = listData.data?.find((s) => s.subdomain === "group-site")
    expect(site?.oauth?.allowedGroups).toEqual(["admins", "devs"])
  })

  test("should replace OAuth when called again", async () => {
    await deploySite("replace-site")

    // First set emails
    await fetch(`http://localhost:${TEST_PORT}/sites/replace-site/auth`, {
      method: "PATCH",
      headers: {
        "X-API-Key": TEST_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ allowedEmails: ["old@example.com"] }),
    })

    // Now replace with domain
    await fetch(`http://localhost:${TEST_PORT}/sites/replace-site/auth`, {
      method: "PATCH",
      headers: {
        "X-API-Key": TEST_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ allowedDomain: "new.com" }),
    })

    // Verify - should have domain, not emails
    const listRes = await fetch(`http://localhost:${TEST_PORT}/sites`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    const listData = await parseJson<SiteInfo[]>(listRes)
    const site = listData.data?.find((s) => s.subdomain === "replace-site")
    expect(site?.oauth?.allowedDomain).toBe("new.com")
    expect(site?.oauth?.allowedEmails).toBeUndefined()
  })

  test("should remove OAuth with remove: true", async () => {
    await deploySite("remove-site")

    // Set OAuth first
    await fetch(`http://localhost:${TEST_PORT}/sites/remove-site/auth`, {
      method: "PATCH",
      headers: {
        "X-API-Key": TEST_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ allowedEmails: ["user@example.com"] }),
    })

    // Verify it's set
    let listRes = await fetch(`http://localhost:${TEST_PORT}/sites`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    let listData = await parseJson<SiteInfo[]>(listRes)
    let site = listData.data?.find((s) => s.subdomain === "remove-site")
    expect(site?.oauth).toBeDefined()

    // Remove OAuth
    const response = await fetch(`http://localhost:${TEST_PORT}/sites/remove-site/auth`, {
      method: "PATCH",
      headers: {
        "X-API-Key": TEST_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ remove: true }),
    })

    expect(response.ok).toBe(true)

    // Verify it's removed
    listRes = await fetch(`http://localhost:${TEST_PORT}/sites`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    listData = await parseJson<SiteInfo[]>(listRes)
    site = listData.data?.find((s) => s.subdomain === "remove-site")
    expect(site?.oauth).toBeUndefined()
  })

  test("should lowercase emails when setting OAuth", async () => {
    await deploySite("case-site")

    await fetch(`http://localhost:${TEST_PORT}/sites/case-site/auth`, {
      method: "PATCH",
      headers: {
        "X-API-Key": TEST_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ allowedEmails: ["User@EXAMPLE.COM"] }),
    })

    // Verify emails are lowercased
    const listRes = await fetch(`http://localhost:${TEST_PORT}/sites`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    const listData = await parseJson<SiteInfo[]>(listRes)
    const site = listData.data?.find((s) => s.subdomain === "case-site")
    expect(site?.oauth?.allowedEmails).toEqual(["user@example.com"])
  })

  test("should lowercase domain when setting OAuth", async () => {
    await deploySite("case-domain-site")

    await fetch(`http://localhost:${TEST_PORT}/sites/case-domain-site/auth`, {
      method: "PATCH",
      headers: {
        "X-API-Key": TEST_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ allowedDomain: "COMPANY.COM" }),
    })

    // Verify domain is lowercased
    const listRes = await fetch(`http://localhost:${TEST_PORT}/sites`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    const listData = await parseJson<SiteInfo[]>(listRes)
    const site = listData.data?.find((s) => s.subdomain === "case-domain-site")
    expect(site?.oauth?.allowedDomain).toBe("company.com")
  })

  test("should set OAuth during deployment via headers", async () => {
    const files: Record<string, Uint8Array> = {
      "index.html": new TextEncoder().encode("<html><body>Test</body></html>"),
    }
    const zipData = zipSync(files, { level: 6 })

    const response = await fetch(`http://localhost:${TEST_PORT}/sites/header-oauth`, {
      method: "POST",
      headers: {
        "X-API-Key": TEST_API_KEY,
        "Content-Type": "application/zip",
        "X-Site-OAuth-Emails": "user1@example.com,user2@example.com",
      },
      body: zipData,
    })

    expect(response.ok).toBe(true)
    const data = await parseJson<SiteInfo>(response)
    expect(data.data?.oauth?.allowedEmails).toEqual(["user1@example.com", "user2@example.com"])
  })

  test("should set OAuth domain during deployment via headers", async () => {
    const files: Record<string, Uint8Array> = {
      "index.html": new TextEncoder().encode("<html><body>Test</body></html>"),
    }
    const zipData = zipSync(files, { level: 6 })

    const response = await fetch(`http://localhost:${TEST_PORT}/sites/header-domain`, {
      method: "POST",
      headers: {
        "X-API-Key": TEST_API_KEY,
        "Content-Type": "application/zip",
        "X-Site-OAuth-Domain": "company.com",
      },
      body: zipData,
    })

    expect(response.ok).toBe(true)
    const data = await parseJson<SiteInfo>(response)
    expect(data.data?.oauth?.allowedDomain).toBe("company.com")
  })
})
