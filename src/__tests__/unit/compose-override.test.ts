import { describe, test, expect } from "bun:test"
import { buildOverride } from "../../lib/agent/compose-override"
import { APP_ROUTER_PRIORITY } from "../../lib/agent/traefik"
import type { App } from "../../types"

function appWithCompose(overrides: Partial<App> = {}): App {
  return {
    name: "myapp",
    type: "container",
    image: "siteio-myapp:latest",
    compose: { source: "inline", primaryService: "web" },
    env: {},
    volumes: [],
    internalPort: 3000,
    restartPolicy: "unless-stopped",
    domains: ["myapp.example.com"],
    status: "pending",
    createdAt: "2026-04-19T00:00:00Z",
    updatedAt: "2026-04-19T00:00:00Z",
    ...overrides,
  }
}

// Most cases route to the app's own domains; the domain-resolution tests pass them explicitly.
function build(app: App, dataDir?: string): string {
  return buildOverride(app, { domains: app.domains, baseNetworks: [], dataDir })
}

describe("Unit: buildOverride", () => {
  test("emits services.<primary>.networks with siteio-network", () => {
    const yaml = build(appWithCompose())
    expect(yaml).toContain("services:")
    expect(yaml).toMatch(/^ {2}web:/m)
    expect(yaml).toMatch(/networks:\s+- "siteio-network"/m)
  })

  test("keeps the implicit default network the base file resolved to", () => {
    // Without it, the primary service can no longer resolve its siblings (redis, db…).
    const yaml = buildOverride(appWithCompose(), { domains: ["x.test"], baseNetworks: ["default"] })
    expect(yaml).toMatch(/networks:\s+- "default"\s+- "siteio-network"/m)
  })

  test("re-lists every custom base network, not just default", () => {
    const yaml = buildOverride(appWithCompose(), { domains: ["x.test"], baseNetworks: ["backend", "frontend"] })
    expect(yaml).toMatch(/networks:\s+- "backend"\s+- "frontend"\s+- "siteio-network"/m)
    expect(yaml).not.toContain('- "default"')
  })

  test("does not list siteio-network twice when the base file already joins it", () => {
    const yaml = buildOverride(appWithCompose(), { domains: ["x.test"], baseNetworks: ["siteio-network", "default"] })
    expect(yaml.match(/- "siteio-network"/g)).toHaveLength(1)
  })

  test("quotes hostile network names so they cannot inject YAML keys", () => {
    const yaml = buildOverride(appWithCompose(), { domains: ["x.test"], baseNetworks: ["evil\n    privileged: true"] })
    expect(yaml).not.toMatch(/^\s+privileged: true/m)
  })

  test("declares siteio-network as external", () => {
    const yaml = build(appWithCompose())
    expect(yaml).toMatch(/^networks:\s+siteio-network:\s+external: true/ms)
  })

  test("emits Traefik labels for a single domain", () => {
    const yaml = build(appWithCompose({ domains: ["app.example.com"] }))
    expect(yaml).toContain('traefik.enable: "true"')
    expect(yaml).toContain('traefik.docker.network: "siteio-network"')
    expect(yaml).toContain('traefik.http.routers.siteio-myapp.entrypoints: "websecure"')
    expect(yaml).toContain('traefik.http.routers.siteio-myapp.tls.certresolver: "letsencrypt"')
    expect(yaml).toContain('traefik.http.services.siteio-myapp.loadbalancer.server.port: "3000"')
    expect(yaml).toContain(`traefik.http.routers.siteio-myapp.priority: "${APP_ROUTER_PRIORITY}"`)
    expect(yaml).toContain('traefik.http.routers.siteio-myapp.rule: "Host(`app.example.com`)"')
  })

  test("ORs multiple domains with `||`", () => {
    const yaml = build(appWithCompose({ domains: ["a.example.com", "b.example.com"] }))
    expect(yaml).toContain(
      'traefik.http.routers.siteio-myapp.rule: "Host(`a.example.com`) || Host(`b.example.com`)"'
    )
  })

  test("emits env vars as a map under the primary service", () => {
    const yaml = build(appWithCompose({ env: { FOO: "bar", DATABASE_URL: "postgres://db/x" } }))
    expect(yaml).toMatch(/environment:\s+FOO: "bar"/m)
    expect(yaml).toContain('DATABASE_URL: "postgres://db/x"')
  })

  test("omits environment block when env is empty", () => {
    const yaml = build(appWithCompose({ env: {} }))
    expect(yaml).not.toContain("environment:")
  })

  test("emits volumes under the primary service when present", () => {
    const yaml = build(
      appWithCompose({ volumes: [{ name: "data", mountPath: "/data" }] })
    )
    expect(yaml).toMatch(/volumes:\s+- /m)
    expect(yaml).toContain(":/data")
  })

  test("omits volumes block when list is empty", () => {
    const yaml = build(appWithCompose({ volumes: [] }))
    expect(yaml).not.toMatch(/^ {4}volumes:/m)
  })

  test("escapes backtick-containing rule value by quoting the full string", () => {
    const yaml = build(appWithCompose({ domains: ["x.test"] }))
    const line = yaml.split("\n").find((l) => l.includes("routers.siteio-myapp.rule"))!
    expect(line.trim().startsWith("traefik.http.routers.siteio-myapp.rule:")).toBe(true)
    expect(line).toContain('"Host(`x.test`)"')
  })

  test("escapes newlines in env values as \\n literals", () => {
    const yaml = build(
      appWithCompose({ env: { CERT: "line1\nline2\nline3" } })
    )
    expect(yaml).toContain('CERT: "line1\\nline2\\nline3"')
    // And must NOT contain a raw newline inside a quoted value (would be folded by YAML parsers)
    const certLine = yaml.split("\n").find((l) => l.includes("CERT:"))!
    expect(certLine).toBe('      CERT: "line1\\nline2\\nline3"')
  })

  test("escapes tabs and carriage returns in env values", () => {
    const yaml = build(
      appWithCompose({ env: { MSG: "a\tb\r\nc" } })
    )
    expect(yaml).toContain('MSG: "a\\tb\\r\\nc"')
  })

  test("throws when called on a non-compose app", () => {
    const nonCompose: Parameters<typeof buildOverride>[0] = {
      name: "plain",
      type: "container",
      image: "nginx",
      env: {},
      volumes: [],
      internalPort: 80,
      restartPolicy: "unless-stopped",
      domains: [],
      status: "pending",
      createdAt: "2026-04-19T00:00:00Z",
      updatedAt: "2026-04-19T00:00:00Z",
    }
    expect(() => buildOverride(nonCompose, { domains: ["plain.example.com"], baseNetworks: [] })).toThrow(/non-compose/)
  })

  test("routes on the domains passed in, not app.domains", () => {
    // App has no custom domain: the caller resolves the default subdomain.
    const yaml = buildOverride(appWithCompose({ domains: [] }), { domains: ["myapp.base.test"], baseNetworks: [] })
    expect(yaml).toContain('traefik.http.routers.siteio-myapp.rule: "Host(`myapp.base.test`)"')
  })

  test("ignores stale app.domains when resolved domains differ", () => {
    const yaml = buildOverride(appWithCompose({ domains: ["old.example.com"] }), { domains: ["new.example.com"], baseNetworks: [] })
    expect(yaml).toContain("Host(`new.example.com`)")
    expect(yaml).not.toContain("old.example.com")
  })

  test("refuses to build a router without a Host rule", () => {
    // A rule-less router makes Traefik answer 404 with its default certificate.
    expect(() => buildOverride(appWithCompose({ domains: [] }), { domains: [], baseNetworks: [] })).toThrow(/without domains/)
  })

  test("readonly volumes emit the :ro suffix", () => {
    const yaml = build(
      appWithCompose({ volumes: [{ name: "data", mountPath: "/data", readonly: true }] })
    )
    const volLine = yaml.split("\n").find((l) => l.trim().startsWith("- ") && l.includes("/data"))!
    expect(volLine).toContain(":/data:ro\"")
  })

  test("absolute-path volumes use the host path directly", () => {
    const yaml = build(
      appWithCompose({ volumes: [{ name: "/srv/shared", mountPath: "/data" }] })
    )
    const volLine = yaml.split("\n").find((l) => l.trim().startsWith("- ") && l.includes("/data"))!
    // Must NOT prepend the dataDir volumes dir
    expect(volLine).not.toContain("volumes/myapp")
    expect(volLine).toContain('"/srv/shared:/data"')
  })

  test("custom dataDir threads through volume path resolution", () => {
    const yaml = build(
      appWithCompose({ volumes: [{ name: "data", mountPath: "/data" }] }),
      "/custom/data/root"
    )
    const volLine = yaml.split("\n").find((l) => l.trim().startsWith("- ") && l.includes("/data"))!
    expect(volLine).toContain("/custom/data/root/volumes/myapp/data:/data")
  })
})
