import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { TraefikManager } from "../../lib/agent/traefik.ts"
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs"
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
    expect(dynamicConfig).toContain("http://siteio-oauth2-proxy:4180/")
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

  it("generates nginx server blocks for sites with custom domains", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
    })

    traefik.updateNginxConfig([
      {
        subdomain: "my-blog",
        domains: ["mycoolsite.com", "www.mycoolsite.com"],
        size: 1024,
        deployedAt: "2024-01-01T00:00:00Z",
        files: ["index.html"],
      },
    ])

    const nginxConfig = readFileSync(join(TEST_DATA_DIR, "nginx", "default.conf"), "utf-8")
    expect(nginxConfig).toContain("server_name mycoolsite.com;")
    expect(nginxConfig).toContain("server_name www.mycoolsite.com;")
    expect(nginxConfig).toContain("root /sites/my-blog;")
  })

  it("does not generate extra server blocks for sites without custom domains", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
    })

    traefik.updateNginxConfig([
      {
        subdomain: "plain-site",
        size: 1024,
        deployedAt: "2024-01-01T00:00:00Z",
        files: ["index.html"],
      },
    ])

    const nginxConfig = readFileSync(join(TEST_DATA_DIR, "nginx", "default.conf"), "utf-8")
    // Should have the regex catch-all but no explicit server_name for custom domains
    expect(nginxConfig).toContain("server_name ~^")
    expect(nginxConfig).not.toContain("server_name plain-site")
  })

  it("generates Traefik routers for custom domains", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
    })

    const dynamicConfig = traefik.generateDynamicConfig([
      {
        subdomain: "my-blog",
        domains: ["mycoolsite.com", "www.mycoolsite.com"],
        size: 1024,
        deployedAt: "2024-01-01T00:00:00Z",
        files: ["index.html"],
      },
    ])

    expect(dynamicConfig).toContain("site-my-blog-cd-0")
    expect(dynamicConfig).toContain("mycoolsite.com")
    expect(dynamicConfig).toContain("site-my-blog-cd-1")
    expect(dynamicConfig).toContain("www.mycoolsite.com")
  })

  it("adds per-site logout router for OAuth-protected site", () => {
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
        oauth: { allowedEmails: ["user@example.com"] },
      },
    ])

    // Should have a logout router for the site
    expect(dynamicConfig).toContain("site-protected-logout")
    // Logout router should match /logout path on the site host
    expect(dynamicConfig).toContain("Host(`protected.test.siteio.me`) && Path(`/logout`)")
    // Should have a per-site logout redirect middleware
    expect(dynamicConfig).toContain("site-protected-logout-redirect")
    // Redirect should go through oauth2-proxy sign_out
    expect(dynamicConfig).toContain("auth.test.siteio.me/oauth2/sign_out")
    // Auth0 logout should return to the site root (double-encoded inside the rd param)
    expect(dynamicConfig).toContain(encodeURIComponent(encodeURIComponent("https://protected.test.siteio.me/")))
  })

  it("does not add logout router for public site", () => {
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
        subdomain: "public",
        size: 1024,
        deployedAt: "2024-01-01T00:00:00Z",
        files: ["index.html"],
      },
    ])

    expect(dynamicConfig).not.toContain("site-public-logout")
  })

  it("adds logout router for custom domain on OAuth-protected site", () => {
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
        subdomain: "my-blog",
        domains: ["mycoolsite.com"],
        size: 1024,
        deployedAt: "2024-01-01T00:00:00Z",
        files: ["index.html"],
        oauth: { allowedEmails: ["user@example.com"] },
      },
    ])

    // Should have logout routers for both subdomain and custom domain
    expect(dynamicConfig).toContain("site-my-blog-logout")
    expect(dynamicConfig).toContain("Host(`my-blog.test.siteio.me`) && Path(`/logout`)")
    expect(dynamicConfig).toContain("site-my-blog-cd-0-logout")
    expect(dynamicConfig).toContain("Host(`mycoolsite.com`) && Path(`/logout`)")
    // Custom domain logout should return to the custom domain (double-encoded inside the rd param)
    expect(dynamicConfig).toContain(encodeURIComponent(encodeURIComponent("https://mycoolsite.com/")))
  })

  it("generates nginx config with sub_filter for site with persistentStorage", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
    })

    traefik.updateNginxConfig([
      {
        subdomain: "storage-site",
        size: 1024,
        deployedAt: "2024-01-01T00:00:00Z",
        files: ["index.html"],
        persistentStorage: true,
      },
    ])

    const nginxConfig = readFileSync(join(TEST_DATA_DIR, "nginx", "default.conf"), "utf-8")
    // Should have explicit server block for the persistent storage site
    expect(nginxConfig).toContain("server_name storage-site.test.siteio.me;")
    // Should have sub_filter injection
    expect(nginxConfig).toContain("sub_filter '</head>'")
    expect(nginxConfig).toContain("/__storage/shim.js")
    // Should have proxy location for /__storage/
    expect(nginxConfig).toContain("location /__storage/")
    expect(nginxConfig).toContain("proxy_pass http://host.docker.internal:3000")
  })

  it("does not include sub_filter for site without persistentStorage", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
    })

    traefik.updateNginxConfig([
      {
        subdomain: "normal-site",
        size: 1024,
        deployedAt: "2024-01-01T00:00:00Z",
        files: ["index.html"],
      },
    ])

    const nginxConfig = readFileSync(join(TEST_DATA_DIR, "nginx", "default.conf"), "utf-8")
    expect(nginxConfig).not.toContain("sub_filter")
    expect(nginxConfig).not.toContain("/__storage/")
  })

  it("includes sub_filter in custom domain server blocks when site has persistentStorage", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
    })

    traefik.updateNginxConfig([
      {
        subdomain: "my-app",
        domains: ["myapp.com"],
        size: 1024,
        deployedAt: "2024-01-01T00:00:00Z",
        files: ["index.html"],
        persistentStorage: true,
      },
    ])

    const nginxConfig = readFileSync(join(TEST_DATA_DIR, "nginx", "default.conf"), "utf-8")
    // Both subdomain and custom domain blocks should have sub_filter
    expect(nginxConfig).toContain("server_name my-app.test.siteio.me;")
    expect(nginxConfig).toContain("server_name myapp.com;")
    // Count occurrences of sub_filter - should appear in both blocks
    const subFilterCount = (nginxConfig.match(/sub_filter '<\/head>'/g) || []).length
    expect(subFilterCount).toBe(2)
  })

  it("applies OAuth middlewares to custom domain routers", () => {
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
        subdomain: "my-blog",
        domains: ["mycoolsite.com"],
        size: 1024,
        deployedAt: "2024-01-01T00:00:00Z",
        files: ["index.html"],
        oauth: { allowedEmails: ["user@example.com"] },
      },
    ])

    // Custom domain router should exist
    expect(dynamicConfig).toContain("site-my-blog-cd-0")
    expect(dynamicConfig).toContain("mycoolsite.com")

    // Parse to verify the custom domain router has middlewares
    const lines = dynamicConfig.split("\n")
    const cdRouterIndex = lines.findIndex((l) => l.includes("site-my-blog-cd-0:"))
    expect(cdRouterIndex).toBeGreaterThan(-1)

    // Check that middlewares appear within this router's section
    let hasMiddlewares = false
    for (let i = cdRouterIndex + 1; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      // If we hit another top-level router key (4 spaces), stop
      if (line.match(/^ {4}\w+-[\w-]+:$/)) break
      // If we hit services section (2 spaces), stop
      if (line.match(/^ {2}services:/)) break
      if (line.match(/^ {6}middlewares:/)) {
        hasMiddlewares = true
        break
      }
    }
    expect(hasMiddlewares).toBe(true)
  })
})
