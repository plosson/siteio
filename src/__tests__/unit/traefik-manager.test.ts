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

  it("adds forwardAuth middleware when oauthConfig is set", () => {
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
    expect(dynamicConfig).toContain("siteio-auth")
    expect(dynamicConfig).toContain("forwardAuth")
    expect(dynamicConfig).toContain("/auth/check")
  })

  it("does not include forwardAuth middleware without oauthConfig", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
    })

    const dynamicConfig = traefik.generateDynamicConfig([])
    expect(dynamicConfig).not.toContain("siteio-auth")
    expect(dynamicConfig).not.toContain("forwardAuth")
  })

  it("does not include site routers in dynamic config (handled by container labels)", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
    })

    // Pass a site metadata array - these should NOT appear in dynamic config
    const dynamicConfig = traefik.generateDynamicConfig([
      { subdomain: "mysite", size: 1024, deployedAt: "2024-01-01T00:00:00Z", files: ["index.html"] },
    ])

    // Only API router should exist, not site router
    expect(dynamicConfig).toContain("api-router")
    expect(dynamicConfig).not.toContain("mysite-router")
    expect(dynamicConfig).not.toContain("mysite-service")
  })
})
