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

  const makeTraefik = (extra: Partial<ConstructorParameters<typeof TraefikManager>[0]> = {}) =>
    new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
      ...extra,
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
    // No trace of the pre-merge nginx/oauth machinery
    expect(dynamicConfig).not.toContain("nginx")
    expect(dynamicConfig).not.toContain("oauth")
  })

  it("creates config and certs directories with acme.json", () => {
    makeTraefik()
    expect(existsSync(join(TEST_DATA_DIR, "traefik"))).toBe(true)
    expect(existsSync(join(TEST_DATA_DIR, "certs", "acme.json"))).toBe(true)
  })
})
