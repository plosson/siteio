import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { TraefikManager } from "../../lib/agent/traefik.ts"
import { mkdirSync, rmSync, existsSync } from "fs"
import { join } from "path"

describe("Unit: TraefikManager", () => {
  const TEST_DATA_DIR = join(import.meta.dir, ".test-data-traefik")

  beforeEach(() => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
    mkdirSync(TEST_DATA_DIR, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
  })

  it("generates config with docker provider for container apps", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
    })

    const staticConfig = traefik.generateStaticConfig()
    expect(staticConfig).toContain("docker:")
    expect(staticConfig).toContain("exposedByDefault: false")
  })

  it("only includes API service in dynamic config (containers use labels)", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
    })

    const dynamicConfig = traefik.generateDynamicConfig([])
    expect(dynamicConfig).toContain("api-router")
    expect(dynamicConfig).toContain("api-service")
  })

  it("adds global OAuth middlewares when oauthConfig is present", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
      oauthConfig: {
        issuerUrl: "https://auth.example.com",
        clientId: "test-client",
        clientSecret: "test-secret",
        cookieSecret: "test-cookie-secret",
        cookieDomain: "test.siteio.me",
      },
    })

    const dynamicConfig = traefik.generateDynamicConfig([])

    // Should have oauth2-proxy-auth middleware
    expect(dynamicConfig).toContain("oauth2-proxy-auth")
    expect(dynamicConfig).toContain("forwardAuth")
    expect(dynamicConfig).toContain("http://siteio-oauth2-proxy:4180/oauth2/auth")
    expect(dynamicConfig).toContain("trustForwardHeader")
    expect(dynamicConfig).toContain("X-Auth-Request-Email")
    expect(dynamicConfig).toContain("X-Auth-Request-User")
    expect(dynamicConfig).toContain("X-Auth-Request-Groups")

    // Should have siteio-authz middleware
    expect(dynamicConfig).toContain("siteio-authz")
    expect(dynamicConfig).toContain("http://host.docker.internal:3000/auth/check")
  })

  it("adds auth router and oauth2-proxy service when oauthConfig is present", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
      oauthConfig: {
        issuerUrl: "https://auth.example.com",
        clientId: "test-client",
        clientSecret: "test-secret",
        cookieSecret: "test-cookie-secret",
        cookieDomain: "test.siteio.me",
      },
    })

    const dynamicConfig = traefik.generateDynamicConfig([])

    // Should have auth router pointing to auth.{domain}
    expect(dynamicConfig).toContain("auth-router")
    expect(dynamicConfig).toContain("auth.test.siteio.me")

    // Should have oauth2-proxy service
    expect(dynamicConfig).toContain("oauth2-proxy-service")
    expect(dynamicConfig).toContain("siteio-oauth2-proxy:4180")
  })

  it("does not add auth router when oauthConfig is not present", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
      // No oauthConfig
    })

    const dynamicConfig = traefik.generateDynamicConfig([])

    // Should NOT have auth router or oauth2-proxy service
    expect(dynamicConfig).not.toContain("auth-router")
    expect(dynamicConfig).not.toContain("oauth2-proxy-service")
  })

  it("includes site routers in dynamic config", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
    })

    const dynamicConfig = traefik.generateDynamicConfig([
      { subdomain: "mysite", size: 1024, deployedAt: "2024-01-01T00:00:00Z", files: ["index.html"] },
    ])

    expect(dynamicConfig).toContain("api-router")
    expect(dynamicConfig).toContain("site-mysite")
    expect(dynamicConfig).toContain("mysite.test.siteio.me")
  })

  it("includes global OAuth middlewares when oauthConfig is present with protected site", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
      oauthConfig: {
        issuerUrl: "https://auth.example.com",
        clientId: "test-client",
        clientSecret: "test-secret",
        cookieSecret: "test-cookie-secret",
        cookieDomain: "test.siteio.me",
      },
    })

    const dynamicConfig = traefik.generateDynamicConfig([
      {
        subdomain: "protected-site",
        size: 1024,
        deployedAt: "2024-01-01T00:00:00Z",
        files: ["index.html"],
        oauth: { allowedEmails: ["user@example.com"] },
      },
    ])

    // Site router exists
    expect(dynamicConfig).toContain("site-protected-site")
    // Global OAuth middlewares are defined
    expect(dynamicConfig).toContain("middlewares:")
    expect(dynamicConfig).toContain("oauth2-proxy-auth")
    expect(dynamicConfig).toContain("siteio-authz")
  })

  it("does not add middleware to site router when site has no OAuth", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
      oauthConfig: {
        issuerUrl: "https://auth.example.com",
        clientId: "test-client",
        clientSecret: "test-secret",
        cookieSecret: "test-cookie-secret",
        cookieDomain: "test.siteio.me",
      },
    })

    const dynamicConfig = traefik.generateDynamicConfig([
      {
        subdomain: "public-site",
        size: 1024,
        deployedAt: "2024-01-01T00:00:00Z",
        files: ["index.html"],
        // No oauth field
      },
    ])

    // Check that the site router doesn't have middlewares in its section
    // The config should have site-public-site router without middlewares array
    expect(dynamicConfig).toContain("site-public-site")

    // Parse YAML to check the router's structure specifically
    const lines = dynamicConfig.split("\n")
    const publicSiteIndex = lines.findIndex((l) => l.includes("site-public-site:"))

    // Find the next router (or services section) to check this router's config
    let hasMiddlewares = false
    for (let i = publicSiteIndex + 1; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      // If we hit another top-level router key (4 spaces), stop
      if (line.match(/^ {4}\w+-[\w-]+:$/)) {
        break
      }
      // If we hit services section (2 spaces), stop
      if (line.match(/^ {2}services:/)) {
        break
      }
      // Check for middlewares inside this router (6 spaces indent)
      if (line.match(/^ {6}middlewares:/)) {
        hasMiddlewares = true
        break
      }
    }
    expect(hasMiddlewares).toBe(false)
  })

  it("does not add middleware when site has OAuth but server has no oauthConfig", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
      // No oauthConfig
    })

    const dynamicConfig = traefik.generateDynamicConfig([
      {
        subdomain: "oauth-site",
        size: 1024,
        deployedAt: "2024-01-01T00:00:00Z",
        files: ["index.html"],
        oauth: { allowedEmails: ["user@example.com"] },
      },
    ])

    // Even though site has oauth, no middleware should be added because
    // the server doesn't have oauthConfig (so middleware isn't defined)
    expect(dynamicConfig).toContain("site-oauth-site")
    expect(dynamicConfig).not.toContain("middlewares:")
    expect(dynamicConfig).not.toContain("siteio-auth")
  })

  it("generates static config with API enabled", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
    })

    const staticConfig = traefik.generateStaticConfig()
    expect(staticConfig).toContain("api:")
    expect(staticConfig).toContain("insecure: true")
  })

  it("correctly handles multiple sites with global OAuth middlewares defined", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
      oauthConfig: {
        issuerUrl: "https://auth.example.com",
        clientId: "test-client",
        clientSecret: "test-secret",
        cookieSecret: "test-cookie-secret",
        cookieDomain: "test.siteio.me",
      },
    })

    const dynamicConfig = traefik.generateDynamicConfig([
      {
        subdomain: "protected",
        size: 1024,
        deployedAt: "2024-01-01T00:00:00Z",
        files: ["index.html"],
        oauth: { allowedDomain: "company.com" },
      },
      {
        subdomain: "public",
        size: 1024,
        deployedAt: "2024-01-01T00:00:00Z",
        files: ["index.html"],
      },
      {
        subdomain: "also-protected",
        size: 1024,
        deployedAt: "2024-01-01T00:00:00Z",
        files: ["index.html"],
        oauth: { allowedGroups: ["admins"] },
      },
    ])

    // All three sites should have routers
    expect(dynamicConfig).toContain("site-protected")
    expect(dynamicConfig).toContain("site-public")
    expect(dynamicConfig).toContain("site-also-protected")

    // Global OAuth middlewares are defined
    expect(dynamicConfig).toContain("oauth2-proxy-auth")
    expect(dynamicConfig).toContain("siteio-authz")
    expect(dynamicConfig).toContain("forwardAuth")
  })
})
