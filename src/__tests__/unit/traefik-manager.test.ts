import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { TraefikManager, accessLogPath } from "../../lib/agent/traefik.ts"
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "fs"
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

  it("leaves a complete dynamic config and no temp file behind", () => {
    const traefik = makeTraefik()
    traefik.setApiHosts(["api.test.siteio.me", "api.third.net"])
    const dir = join(TEST_DATA_DIR, "traefik")
    expect(readdirSync(dir).filter((f) => f.startsWith("dynamic.yml"))).toEqual(["dynamic.yml"])
    expect(readFileSync(join(dir, "dynamic.yml"), "utf-8")).toBe(traefik.generateDynamicConfig())
  })

  it("cleans up the temp file when the write fails", () => {
    const traefik = makeTraefik()
    traefik.updateDynamicConfig()
    const dir = join(TEST_DATA_DIR, "traefik")
    // Make the rename fail: a directory cannot be replaced by a file.
    rmSync(join(dir, "dynamic.yml"))
    mkdirSync(join(dir, "dynamic.yml"))
    expect(() => traefik.setApiHosts(["api.other.net"])).toThrow()
    expect(readdirSync(dir).filter((f) => f.includes("tmp"))).toEqual([])
  })

  it("never exposes an empty or partial dynamic config to a concurrent reader", async () => {
    const traefik = makeTraefik()
    // Two different, large host lists written alternately: an in-place write
    // shows a reader a mix of both (or an empty file) mid-rewrite.
    const hostSets = ["a", "b"].map((p) => Array.from({ length: 20000 }, (_, i) => `api.${p}${i}.example.com`))
    const configs = hostSets.map((h) => {
      traefik.setApiHosts(h)
      return traefik.generateDynamicConfig()
    })
    const file = join(TEST_DATA_DIR, "traefik", "dynamic.yml")
    await Bun.write(file + ".expected", JSON.stringify(configs))
    // Reader runs in a separate process: the writer below is synchronous and
    // would starve an in-process poller.
    const reader = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `const fs=require("fs");const f=process.argv[1];const want=JSON.parse(fs.readFileSync(f+".expected","utf-8"));
         let bad=0,n=0;console.log("ready");
         while(!fs.existsSync(f+".stop")){n++;let t="";try{t=fs.readFileSync(f,"utf-8")}catch{bad++;continue}
           if(!want.includes(t)||!t.includes("api-router"))bad++}
         console.log(JSON.stringify({bad,n}))`,
        file,
      ],
      stdout: "pipe",
    })
    const out = reader.stdout.getReader()
    await out.read() // wait for "ready"
    let text = ""
    try {
      for (let i = 0; i < 200; i++) traefik.setApiHosts(hostSets[i % 2]!)
    } finally {
      await Bun.write(file + ".stop", "")
      setTimeout(() => reader.kill(), 30000).unref()
    }
    for (;;) {
      const { value, done } = await out.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    await reader.exited
    expect(reader.exitCode).toBe(0)
    const result = JSON.parse(text.trim().split("\n").pop()!)
    expect(result.n).toBeGreaterThan(0)
    expect(result.bad).toBe(0)
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

  describe("tenants with platform paths off", () => {
    const PATHS =
      "PathPrefix(`/mcp`) || PathPrefix(`/_siteio`) || " +
      "PathPrefix(`/.well-known/oauth-authorization-server`) || PathPrefix(`/.well-known/oauth-protected-resource`)"
    // The mcp-router rule as Traefik reads it (after JSON + YAML unescaping).
    const mcpRule = (yml: string): string =>
      (Bun.YAML.parse(yml) as { http: { routers: Record<string, { rule: string }> } }).http.routers["mcp-router"]!.rule
    // The regexes inside `!HostRegexp(...)`, compiled (Go RE2 and JS agree on this subset).
    const excluded = (rule: string): RegExp[] =>
      [...rule.matchAll(/!HostRegexp\(`([^`]*)`\)/g)].map((m) => new RegExp(m[1]!))
    const isExcluded = (rule: string, host: string) => excluded(rule).some((re) => re.test(host))

    it("keeps today's rule exactly when no tenant opts out", () => {
      expect(mcpRule(makeTraefik().generateDynamicConfig())).toBe(PATHS)
      expect(mcpRule(makeTraefik({ platformOffDomains: [] }).generateDynamicConfig())).toBe(PATHS)
    })

    it("adds one !HostRegexp per opted-out tenant, dots escaped, around the unchanged paths", () => {
      const rule = mcpRule(makeTraefik({ platformOffDomains: ["k7f2.mynino.app", "b.app"] }).generateDynamicConfig())
      expect(rule).toBe(
        `(${PATHS}) && !HostRegexp(\`^(.+\\.)?k7f2\\.mynino\\.app$\`) && !HostRegexp(\`^(.+\\.)?b\\.app$\`)`,
      )
      expect(rule.match(/!HostRegexp/g)).toHaveLength(2)
    })

    it("excludes the tenant apex and every subdomain, nothing else", () => {
      const rule = mcpRule(makeTraefik({ platformOffDomains: ["k7f2.mynino.app"] }).generateDynamicConfig())
      for (const host of ["k7f2.mynino.app", "bbq.k7f2.mynino.app", "a.b.k7f2.mynino.app"]) {
        expect(isExcluded(rule, host)).toBe(true)
      }
      // A dot left unescaped would match `k7f2Xmynino.app`; a missing anchor would match the rest.
      for (const host of [
        "bbq.mynino.app", "k7f2xmynino.app", "bbq.k7f2xmynino.app", "xk7f2.mynino.app",
        "k7f2.mynino.app.evil.com", "k7f2.mynino.apps", "mynino.app", "api.test.siteio.me", "",
      ]) {
        expect(isExcluded(rule, host)).toBe(false)
      }
    })

    it("a tenant whose domain is a suffix of another does not overmatch (b.app vs ab.app)", () => {
      const rule = mcpRule(makeTraefik({ platformOffDomains: ["b.app"] }).generateDynamicConfig())
      for (const host of ["x.ab.app", "ab.app", "x.cb.app"]) expect(isExcluded(rule, host)).toBe(false)
      for (const host of ["x.b.app", "b.app", "x.y.b.app"]) expect(isExcluded(rule, host)).toBe(true)
    })

    it("escapes every regex metacharacter, and hyphens stay literal", () => {
      const rule = mcpRule(makeTraefik({ platformOffDomains: ["my-site.co.uk", "a+b(c)[d]{e}|f^g$h*i?j\\k.app"] }).generateDynamicConfig())
      expect(isExcluded(rule, "blog.my-site.co.uk")).toBe(true)
      expect(isExcluded(rule, "blog.mysite.co.uk")).toBe(false)
      expect(isExcluded(rule, "blog.my-sitexcoxuk")).toBe(false)
      // The odd domain matches only itself, literally.
      expect(isExcluded(rule, "x.a+b(c)[d]{e}|f^g$h*i?j\\k.app")).toBe(true)
      for (const host of ["x.aab(c)[d]{e}|f^g$h*i?j\\k.app", "f", "x.abc.app", "x.ab.app"]) {
        expect(isExcluded(rule, host)).toBe(false)
      }
    })

    it("setPlatformOffDomains rewrites dynamic.yml, and an empty list restores today's rule", () => {
      const traefik = makeTraefik({ platformOffDomains: ["b.app"] })
      const file = join(TEST_DATA_DIR, "traefik", "dynamic.yml")
      traefik.setPlatformOffDomains(["b.app", "c.app"])
      expect(mcpRule(readFileSync(file, "utf-8")).match(/!HostRegexp/g)).toHaveLength(2)
      traefik.setPlatformOffDomains(["c.app"])
      const after = readFileSync(file, "utf-8")
      expect(mcpRule(after)).not.toContain("b\\.app")
      expect(mcpRule(after)).toContain("c\\.app")
      traefik.setPlatformOffDomains([])
      expect(mcpRule(readFileSync(file, "utf-8"))).toBe(PATHS)
    })

    it("the opted-out list leaves the api router and the other api hosts untouched", () => {
      const traefik = makeTraefik({ apiHosts: ["api.test.siteio.me", "api.b.app"], platformOffDomains: ["b.app"] })
      const routers = (Bun.YAML.parse(traefik.generateDynamicConfig()) as { http: { routers: Record<string, { rule: string; priority?: number }> } }).http.routers
      expect(routers["api-router"]!.rule).toBe("Host(`api.test.siteio.me`) || Host(`api.b.app`)")
      expect(routers["mcp-router"]!.priority).toBe(1000)
    })
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
    expect(yml).toContain("Sec-Fetch-Dest: keep")
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

  it("the logs dir is private: it holds raw request paths until rotated", () => {
    makeTraefik({ accessLog: true })
    expect(statSync(join(TEST_DATA_DIR, "traefik-logs")).mode & 0o777).toBe(0o700)
  })

  describe("wildcard tls.domains per tenant (DNS-01)", () => {
    type Parsed = {
      http: {
        routers: Record<string, { entryPoints: string[]; tls: { certResolver: string; domains?: { main: string; sans?: string[] }[] } }>
      }
    }
    const parse = (yml: string) => Bun.YAML.parse(yml) as Parsed
    const dns = { challenge: "dns" as const, dnsProvider: "cloudflare" }
    const apiHosts = ["api.test.siteio.me", "api.k7f2.mynino.app", "api.x9.mynino.app"]
    const domains = (t: TraefikManager) => parse(t.generateDynamicConfig()).http.routers["api-router"]!.tls.domains

    it("dns: one entry per tenant (apex main, wildcard san) plus the primary api host, which tls.domains would otherwise drop", () => {
      expect(domains(makeTraefik({ acme: dns, apiHosts }))).toEqual([
        { main: "api.test.siteio.me" },
        { main: "k7f2.mynino.app", sans: ["*.k7f2.mynino.app"] },
        { main: "x9.mynino.app", sans: ["*.x9.mynino.app"] },
      ])
    })

    it("the wildcard is quoted in the emitted YAML (a bare `*` is an alias, not a string)", () => {
      const yml = makeTraefik({ acme: dns, apiHosts }).generateDynamicConfig()
      expect(yml).toContain('- "*.k7f2.mynino.app"')
      expect(yml).not.toMatch(/^\s*- \*/m)
    })

    it("dns without tenants: no domains, and the main domain gets no wildcard", () => {
      expect(domains(makeTraefik({ acme: dns }))).toBeUndefined()
      expect(domains(makeTraefik({ acme: dns, apiHosts: ["api.test.siteio.me"] }))).toBeUndefined()
    })

    it("dns: a host already covered by a tenant wildcard gets no extra entry", () => {
      const d = domains(makeTraefik({ acme: dns, apiHosts }))!
      expect(d.map((e) => e.main)).not.toContain("api.k7f2.mynino.app")
    })

    it("setTenantRouting sets both fields with a single write", () => {
      const traefik = makeTraefik({ acme: dns })
      const file = join(TEST_DATA_DIR, "traefik", "dynamic.yml")
      traefik.updateDynamicConfig()
      const before = statSync(file).ino
      traefik.setTenantRouting(apiHosts, ["k7f2.mynino.app"])
      expect(statSync(file).ino).not.toBe(before) // one atomic rename
      const yml = readFileSync(file, "utf-8")
      expect(yml).toContain("api.k7f2.mynino.app")
      expect(yml).toContain("k7f2")
      expect(yml).toContain("HostRegexp")
      expect(parse(yml).http.routers["api-router"]!.tls.domains).toHaveLength(3)
    })

    it("http challenge (explicit or default): no domains, a wildcard cannot be issued", () => {
      expect(domains(makeTraefik({ acme: { challenge: "http" }, apiHosts }))).toBeUndefined()
      expect(domains(makeTraefik({ apiHosts }))).toBeUndefined()
      expect(makeTraefik({ apiHosts }).generateDynamicConfig()).not.toContain("*.")
    })

    it("only the api-router carries domains; mcp-router keeps its plain resolver", () => {
      const routers = parse(makeTraefik({ acme: dns, apiHosts }).generateDynamicConfig()).http.routers
      expect(routers["mcp-router"]!.tls).toEqual({ certResolver: "letsencrypt" })
      expect(routers["api-router"]!.tls.certResolver).toBe("letsencrypt")
    })

    it("existing arrays still parse to the same values", () => {
      const routers = parse(makeTraefik({ acme: dns, apiHosts }).generateDynamicConfig()).http.routers
      expect(routers["api-router"]!.entryPoints).toEqual(["websecure"])
      expect(routers["mcp-router"]!.entryPoints).toEqual(["websecure"])
    })

    it("setApiHosts adds and removes tenants live, rewriting dynamic.yml", () => {
      const traefik = makeTraefik({ acme: dns })
      const file = join(TEST_DATA_DIR, "traefik", "dynamic.yml")
      traefik.setApiHosts(apiHosts)
      expect(parse(readFileSync(file, "utf-8")).http.routers["api-router"]!.tls.domains).toHaveLength(3)
      traefik.setApiHosts(["api.test.siteio.me", "api.x9.mynino.app"])
      expect(parse(readFileSync(file, "utf-8")).http.routers["api-router"]!.tls.domains).toEqual([
        { main: "api.test.siteio.me" },
        { main: "x9.mynino.app", sans: ["*.x9.mynino.app"] },
      ])
      traefik.setApiHosts(["api.test.siteio.me"])
      expect(parse(readFileSync(file, "utf-8")).http.routers["api-router"]!.tls.domains).toBeUndefined()
    })
  })
})
