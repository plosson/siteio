import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { TraefikManager, accessLogPath } from "../../lib/agent/traefik.ts"
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

  const makeTraefik = (extra: Partial<ConstructorParameters<typeof TraefikManager>[0]> = {}) =>
    new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
      ...extra,
    })

  it("routes every api host to the agent", () => {
    const dynamic = makeTraefik({ apiHosts: ["api.test.siteio.me", "api.friend.com"] }).generateDynamicConfig()
    expect(dynamic).toContain("Host(`api.test.siteio.me`) || Host(`api.friend.com`)")
  })

  it("rewrites the watched dynamic config when api hosts change", () => {
    const traefik = makeTraefik()
    traefik.updateDynamicConfig()
    traefik.setApiHosts(["api.test.siteio.me", "api.third.net"])
    const written = readFileSync(join(TEST_DATA_DIR, "traefik", "dynamic.yml"), "utf-8")
    expect(written).toContain("Host(`api.test.siteio.me`) || Host(`api.third.net`)")
  })

  it("defaults to the primary api host", () => {
    expect(makeTraefik().generateDynamicConfig()).toContain("Host(`api.test.siteio.me`)")
  })

  it("generates static config with docker provider for container discovery", () => {
    const staticConfig = makeTraefik().generateStaticConfig()
    expect(staticConfig).toContain("docker:")
    expect(staticConfig).toContain("exposedByDefault: false")
    expect(staticConfig).toContain("network: siteio-network")
  })

  it("static config redirects http to https and configures letsencrypt", () => {
    const staticConfig = makeTraefik({ email: "me@example.com" }).generateStaticConfig()
    expect(staticConfig).toContain("websecure")
    expect(staticConfig).toContain("letsencrypt")
    expect(staticConfig).toContain("email: me@example.com")
    expect(staticConfig).toContain("httpChallenge")
  })

  it("supports dns and tls ACME challenges", () => {
    const dns = makeTraefik({ acme: { challenge: "dns", dnsProvider: "cloudflare" } }).generateStaticConfig()
    expect(dns).toContain("dnsChallenge")
    expect(dns).toContain("provider: cloudflare")

    const tls = makeTraefik({ acme: { challenge: "tls" } }).generateStaticConfig()
    expect(tls).toContain("tlsChallenge")
  })

  it("dynamic config carries only the api router (everything else uses docker labels)", () => {
    const dynamicConfig = makeTraefik().generateDynamicConfig()
    expect(dynamicConfig).toContain("api-router")
    expect(dynamicConfig).toContain("api-service")
    expect(dynamicConfig).toContain("Host(`api.test.siteio.me`)")
    expect(dynamicConfig).toContain("http://host.docker.internal:3000")
    // No trace of the pre-merge nginx/oauth2-proxy machinery
    expect(dynamicConfig).not.toContain("nginx")
    expect(dynamicConfig).not.toContain("oauth2")
  })

  it("dynamic config exposes the MCP share router in front of site containers", () => {
    const dynamicConfig = makeTraefik().generateDynamicConfig()
    expect(dynamicConfig).toContain("mcp-router")
    // Host-agnostic (matches subdomains AND sites' custom/vanity domains); the
    // agent resolves the host to a site. Only the reserved paths are siphoned.
    expect(dynamicConfig).toContain("PathPrefix(`/mcp`)")
    expect(dynamicConfig).toContain("PathPrefix(`/_siteio`)")
    expect(dynamicConfig).toContain("PathPrefix(`/.well-known/oauth-authorization-server`)")
    expect(dynamicConfig).toContain("PathPrefix(`/.well-known/oauth-protected-resource`)")
    // No host constraint on the rule (so custom domains are covered too).
    const mcpBlock = dynamicConfig.slice(dynamicConfig.indexOf("mcp-router"))
    const mcpRule = mcpBlock.slice(0, mcpBlock.indexOf("\n", mcpBlock.indexOf("rule:")))
    expect(mcpRule).not.toContain("HostRegexp")
    // High priority so it beats the site container's Host router.
    expect(dynamicConfig).toContain("priority: 1000")
    // Reuses the agent's own service (and thus its Let's Encrypt cert).
    expect(mcpBlock).toContain('service: "api-service"')
  })

  it("creates config and certs directories with acme.json", () => {
    makeTraefik()
    expect(existsSync(join(TEST_DATA_DIR, "traefik"))).toBe(true)
    expect(existsSync(join(TEST_DATA_DIR, "certs", "acme.json"))).toBe(true)
  })

  it("writes no access log by default", () => {
    expect(makeTraefik().generateStaticConfig()).not.toContain("accessLog")
  })

  it("writes a JSON access log keeping only the headers analytics needs", () => {
    const yml = makeTraefik({ accessLog: true }).generateStaticConfig()
    expect(yml).toContain("accessLog:")
    expect(yml).toContain("filePath: /logs/access.log")
    expect(yml).toContain("format: json")
    expect(yml).toMatch(/headers:\s+defaultMode: drop/)
    expect(yml).toContain("User-Agent: keep")
    expect(yml).toContain("Referer: keep")
    expect(yml).toContain("Content-Type: keep")
    expect(yml).toContain("Cf-Connecting-Ip: keep")
    // Credentials must never reach the log file.
    expect(yml).not.toContain("Authorization: keep")
    expect(yml).not.toContain("Cookie: keep")
    expect(yml).toContain("ClientUsername: drop")
  })

  it("the access log lives outside the read-only config mount", () => {
    expect(accessLogPath(TEST_DATA_DIR)).toBe(join(TEST_DATA_DIR, "traefik-logs", "access.log"))
    makeTraefik({ accessLog: true })
    expect(existsSync(join(TEST_DATA_DIR, "traefik-logs"))).toBe(true)
  })
})
