import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { AgentServer } from "../../lib/agent/server.ts"
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs"
import { join } from "path"
import { zipSync } from "fflate"

describe("API: /auth/check endpoint - Apps", () => {
  const TEST_DATA_DIR = join(import.meta.dir, ".test-data-auth-check")
  const TEST_API_KEY = "test-api-key-auth"
  const TEST_DOMAIN = "test.siteio.me"
  let server: AgentServer
  let baseUrl: string

  beforeAll(async () => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
    mkdirSync(TEST_DATA_DIR, { recursive: true })

    server = new AgentServer({
      domain: TEST_DOMAIN,
      apiKey: TEST_API_KEY,
      dataDir: TEST_DATA_DIR,
      maxUploadSize: 10 * 1024 * 1024,
      skipTraefik: true,
      port: 3098,
      httpPort: 80,
      httpsPort: 443,
    })

    await server.start()
    baseUrl = "http://localhost:3098"
  })

  afterAll(() => {
    server.stop()
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
  })

  beforeEach(() => {
    const appsDir = join(TEST_DATA_DIR, "apps")
    if (existsSync(appsDir)) {
      rmSync(appsDir, { recursive: true })
    }
    mkdirSync(appsDir, { recursive: true })
  })

  it("returns 200 for app without OAuth", async () => {
    const createRes = await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "public-app",
        image: "nginx:alpine",
        internalPort: 80,
      }),
    })
    expect(createRes.ok).toBe(true)

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `public-app.${TEST_DOMAIN}`,
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("returns 401 when OAuth required but no email header", async () => {
    const createRes = await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "protected-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {
          allowedEmails: ["allowed@example.com"],
        },
      }),
    })
    expect(createRes.ok).toBe(true)

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `protected-app.${TEST_DOMAIN}`,
      },
    })
    expect(checkRes.status).toBe(401)
  })

  it("returns 200 when email is in allowedEmails", async () => {
    await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "email-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {
          allowedEmails: ["allowed@example.com"],
        },
      }),
    })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `email-app.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "allowed@example.com",
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("returns 403 when email not in allowedEmails", async () => {
    await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "restricted-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {
          allowedEmails: ["allowed@example.com"],
        },
      }),
    })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `restricted-app.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "notallowed@example.com",
      },
    })
    expect(checkRes.status).toBe(403)
  })

  it("returns 403 with HTML content type", async () => {
    await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "html-type-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {
          allowedEmails: ["allowed@example.com"],
        },
      }),
    })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `html-type-app.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "denied@example.com",
      },
    })
    expect(checkRes.status).toBe(403)
    expect(checkRes.headers.get("Content-Type")).toBe("text/html; charset=utf-8")
  })

  it("403 HTML includes user email", async () => {
    await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "email-display-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {
          allowedEmails: ["allowed@example.com"],
        },
      }),
    })

    const testEmail = "userdisplay@test.com"
    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `email-display-app.${TEST_DOMAIN}`,
        "X-Forwarded-Email": testEmail,
      },
    })
    expect(checkRes.status).toBe(403)
    const html = await checkRes.text()
    expect(html).toContain(testEmail)
  })

  it("403 HTML includes logout link with correct URL pattern", async () => {
    await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "logout-link-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {
          allowedEmails: ["allowed@example.com"],
        },
      }),
    })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `logout-link-app.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "denied@example.com",
      },
    })
    expect(checkRes.status).toBe(403)
    const html = await checkRes.text()
    // Check logout link pattern: https://auth.{domain}/oauth2/sign_out?rd=...
    expect(html).toContain(`https://auth.${TEST_DOMAIN}/oauth2/sign_out?rd=`)
  })

  it("403 HTML works with different email addresses", async () => {
    await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "dynamic-email-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {
          allowedEmails: ["allowed@example.com"],
        },
      }),
    })

    // Test with first email
    const email1 = "first.user@company.org"
    const res1 = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `dynamic-email-app.${TEST_DOMAIN}`,
        "X-Forwarded-Email": email1,
      },
    })
    expect(res1.status).toBe(403)
    const html1 = await res1.text()
    expect(html1).toContain(email1)
    expect(html1).not.toContain("second.user@another.net")

    // Test with second email
    const email2 = "second.user@another.net"
    const res2 = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `dynamic-email-app.${TEST_DOMAIN}`,
        "X-Forwarded-Email": email2,
      },
    })
    expect(res2.status).toBe(403)
    const html2 = await res2.text()
    expect(html2).toContain(email2)
    expect(html2).not.toContain(email1)
  })

  it("returns 200 when email matches allowedDomain", async () => {
    await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "domain-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {
          allowedDomain: "company.com",
        },
      }),
    })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `domain-app.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "employee@company.com",
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("returns 200 for app not found (passthrough)", async () => {
    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `nonexistent.${TEST_DOMAIN}`,
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("returns 200 when using X-Auth-Request-Email header (forwardAuth mode)", async () => {
    await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "forward-auth-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {
          allowedEmails: ["forward@example.com"],
        },
      }),
    })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `forward-auth-app.${TEST_DOMAIN}`,
        "X-Auth-Request-Email": "forward@example.com",
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("returns 200 when oauth is empty object (allow all authenticated)", async () => {
    await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "any-auth-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {},
      }),
    })

    // Without email header, should return 401
    const unauthRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `any-auth-app.${TEST_DOMAIN}`,
      },
    })
    expect(unauthRes.status).toBe(401)

    // With email header, should return 200 (any authenticated user allowed)
    const authRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `any-auth-app.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "anyone@anywhere.com",
      },
    })
    expect(authRes.status).toBe(200)
  })
})

describe("API: /auth/check endpoint - Sites", () => {
  const TEST_DATA_DIR = join(import.meta.dir, ".test-data-site-auth")
  const TEST_API_KEY = "test-api-key-site-auth"
  const TEST_DOMAIN = "test.siteio.me"
  let server: AgentServer
  let baseUrl: string

  // Helper to deploy a test site
  async function deploySite(subdomain: string): Promise<void> {
    const files: Record<string, Uint8Array> = {
      "index.html": new TextEncoder().encode("<html><body>Test</body></html>"),
    }
    const zipData = zipSync(files, { level: 6 })

    const res = await fetch(`${baseUrl}/sites/${subdomain}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/zip",
        "X-API-Key": TEST_API_KEY,
      },
      body: zipData,
    })
    if (!res.ok) {
      throw new Error(`Failed to deploy site: ${await res.text()}`)
    }
  }

  // Helper to set OAuth on a site
  async function setOAuth(subdomain: string, oauth: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${baseUrl}/sites/${subdomain}/auth`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify(oauth),
    })
    if (!res.ok) {
      throw new Error(`Failed to set OAuth: ${await res.text()}`)
    }
  }

  beforeAll(async () => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
    mkdirSync(TEST_DATA_DIR, { recursive: true })

    // Create oauth-config.json to enable OAuth
    writeFileSync(
      join(TEST_DATA_DIR, "oauth-config.json"),
      JSON.stringify({
        issuerUrl: "https://accounts.google.com",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        cookieSecret: "test-cookie-secret-32-chars-long!",
        cookieDomain: ".test.siteio.me",
      })
    )

    // Create groups.json for group tests (array of Group objects)
    writeFileSync(
      join(TEST_DATA_DIR, "groups.json"),
      JSON.stringify([
        { name: "admins", emails: ["admin@example.com", "superadmin@example.com"] },
        { name: "devs", emails: ["dev1@example.com", "dev2@example.com"] },
      ])
    )

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
    // Clean up sites and metadata between tests
    const sitesDir = join(TEST_DATA_DIR, "sites")
    const metadataDir = join(TEST_DATA_DIR, "metadata")
    if (existsSync(sitesDir)) {
      rmSync(sitesDir, { recursive: true })
    }
    if (existsSync(metadataDir)) {
      rmSync(metadataDir, { recursive: true })
    }
    mkdirSync(sitesDir, { recursive: true })
    mkdirSync(metadataDir, { recursive: true })
  })

  it("returns 200 for site without OAuth", async () => {
    await deploySite("public-site")

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        Host: `public-site.${TEST_DOMAIN}`,
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("returns 401 for site with OAuth but no email header", async () => {
    await deploySite("protected-site")
    await setOAuth("protected-site", { allowedEmails: ["allowed@example.com"] })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        Host: `protected-site.${TEST_DOMAIN}`,
      },
    })
    expect(checkRes.status).toBe(401)
  })

  it("returns 200 when email is in allowedEmails", async () => {
    await deploySite("email-site")
    await setOAuth("email-site", { allowedEmails: ["allowed@example.com"] })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        Host: `email-site.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "allowed@example.com",
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("returns 403 when email not in allowedEmails", async () => {
    await deploySite("restricted-site")
    await setOAuth("restricted-site", { allowedEmails: ["allowed@example.com"] })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        Host: `restricted-site.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "notallowed@example.com",
      },
    })
    expect(checkRes.status).toBe(403)
  })

  it("returns 403 with HTML content type", async () => {
    await deploySite("html-type-site")
    await setOAuth("html-type-site", { allowedEmails: ["allowed@example.com"] })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        Host: `html-type-site.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "denied@example.com",
      },
    })
    expect(checkRes.status).toBe(403)
    expect(checkRes.headers.get("Content-Type")).toBe("text/html; charset=utf-8")
  })

  it("403 HTML includes user email", async () => {
    await deploySite("email-display-site")
    await setOAuth("email-display-site", { allowedEmails: ["allowed@example.com"] })

    const testEmail = "sitedisplay@test.com"
    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        Host: `email-display-site.${TEST_DOMAIN}`,
        "X-Forwarded-Email": testEmail,
      },
    })
    expect(checkRes.status).toBe(403)
    const html = await checkRes.text()
    expect(html).toContain(testEmail)
  })

  it("403 HTML includes logout link with correct URL pattern", async () => {
    await deploySite("logout-link-site")
    await setOAuth("logout-link-site", { allowedEmails: ["allowed@example.com"] })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        Host: `logout-link-site.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "denied@example.com",
      },
    })
    expect(checkRes.status).toBe(403)
    const html = await checkRes.text()
    // Check logout link pattern: https://auth.{domain}/oauth2/sign_out?rd=...
    expect(html).toContain(`https://auth.${TEST_DOMAIN}/oauth2/sign_out?rd=`)
  })

  it("403 HTML works with different email addresses", async () => {
    await deploySite("dynamic-email-site")
    await setOAuth("dynamic-email-site", { allowedEmails: ["allowed@example.com"] })

    // Test with first email
    const email1 = "first.site.user@company.org"
    const res1 = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        Host: `dynamic-email-site.${TEST_DOMAIN}`,
        "X-Forwarded-Email": email1,
      },
    })
    expect(res1.status).toBe(403)
    const html1 = await res1.text()
    expect(html1).toContain(email1)
    expect(html1).not.toContain("second.site.user@another.net")

    // Test with second email
    const email2 = "second.site.user@another.net"
    const res2 = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        Host: `dynamic-email-site.${TEST_DOMAIN}`,
        "X-Forwarded-Email": email2,
      },
    })
    expect(res2.status).toBe(403)
    const html2 = await res2.text()
    expect(html2).toContain(email2)
    expect(html2).not.toContain(email1)
  })

  it("returns 200 when email matches allowedDomain", async () => {
    await deploySite("domain-site")
    await setOAuth("domain-site", { allowedDomain: "company.com" })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        Host: `domain-site.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "employee@company.com",
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("returns 403 when email does not match allowedDomain", async () => {
    await deploySite("domain-restricted-site")
    await setOAuth("domain-restricted-site", { allowedDomain: "company.com" })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        Host: `domain-restricted-site.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "outsider@other.com",
      },
    })
    expect(checkRes.status).toBe(403)
  })

  it("returns 200 when email is in allowedGroups", async () => {
    await deploySite("group-site")
    await setOAuth("group-site", { allowedGroups: ["admins"] })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        Host: `group-site.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "admin@example.com",
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("returns 403 when email not in allowedGroups", async () => {
    await deploySite("group-restricted-site")
    await setOAuth("group-restricted-site", { allowedGroups: ["admins"] })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        Host: `group-restricted-site.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "random@example.com",
      },
    })
    expect(checkRes.status).toBe(403)
  })

  it("allows access when multiple groups are specified and email is in one", async () => {
    await deploySite("multi-group-site")
    await setOAuth("multi-group-site", { allowedGroups: ["admins", "devs"] })

    // dev1 is in devs group
    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        Host: `multi-group-site.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "dev1@example.com",
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("returns 200 when using X-Auth-Request-Email header", async () => {
    await deploySite("forward-auth-site")
    await setOAuth("forward-auth-site", { allowedEmails: ["forward@example.com"] })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        Host: `forward-auth-site.${TEST_DOMAIN}`,
        "X-Auth-Request-Email": "forward@example.com",
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("handles case-insensitive email matching", async () => {
    await deploySite("case-site")
    await setOAuth("case-site", { allowedEmails: ["User@Example.COM"] })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        Host: `case-site.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "USER@EXAMPLE.com",
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("handles case-insensitive domain matching", async () => {
    await deploySite("case-domain-site")
    await setOAuth("case-domain-site", { allowedDomain: "Company.COM" })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        Host: `case-domain-site.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "user@COMPANY.com",
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("should look up site by custom domain for auth check", async () => {
    await deploySite("auth-custom")

    // Set custom domain
    const domainRes = await fetch(`${baseUrl}/sites/auth-custom/domains`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({ domains: ["custom.example.org"] }),
    })
    expect(domainRes.ok).toBe(true)

    // Auth check for custom domain — no OAuth set on the site, should allow (200)
    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: { Host: "custom.example.org" },
    })
    expect(checkRes.status).toBe(200)
  })
})
