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

// buildOverride takes the resolved environment as a required argument (a caller
// must not be able to omit the secrets by accident). These cases exercise
// everything else, so they default it to the app's plain env.
const override = (app: App, env: Record<string, string> = app.env): string =>
  buildOverride(app, "/data", env)

describe("Unit: buildOverride", () => {
  test("emits services.<primary>.networks with siteio-network", () => {
    const yaml = override(appWithCompose())
    expect(yaml).toContain("services:")
    expect(yaml).toMatch(/^ {2}web:/m)
    expect(yaml).toMatch(/networks:\s+- siteio-network/m)
  })

  test("declares siteio-network as external", () => {
    const yaml = override(appWithCompose())
    expect(yaml).toMatch(/^networks:\s+siteio-network:\s+external: true/ms)
  })

  test("emits Traefik labels for a single domain", () => {
    const yaml = override(appWithCompose({ domains: ["app.example.com"] }))
    expect(yaml).toContain('traefik.enable: "true"')
    expect(yaml).toContain('traefik.docker.network: "siteio-network"')
    expect(yaml).toContain('traefik.http.routers.siteio-myapp.entrypoints: "websecure"')
    expect(yaml).toContain('traefik.http.routers.siteio-myapp.tls.certresolver: "letsencrypt"')
    expect(yaml).toContain('traefik.http.services.siteio-myapp.loadbalancer.server.port: "3000"')
    expect(yaml).toContain(`traefik.http.routers.siteio-myapp.priority: "${APP_ROUTER_PRIORITY}"`)
    expect(yaml).toContain('traefik.http.routers.siteio-myapp.rule: "Host(`app.example.com`)"')
  })

  test("ORs multiple domains with `||`", () => {
    const yaml = override(appWithCompose({ domains: ["a.example.com", "b.example.com"] }))
    expect(yaml).toContain(
      'traefik.http.routers.siteio-myapp.rule: "Host(`a.example.com`) || Host(`b.example.com`)"'
    )
  })

  test("emits env vars as a map under the primary service", () => {
    const yaml = override(appWithCompose({ env: { FOO: "bar", DATABASE_URL: "postgres://db/x" } }))
    expect(yaml).toMatch(/environment:\s+FOO: "bar"/m)
    expect(yaml).toContain('DATABASE_URL: "postgres://db/x"')
  })

  test("omits environment block when env is empty", () => {
    const yaml = override(appWithCompose({ env: {} }))
    expect(yaml).not.toContain("environment:")
  })

  test("uses the resolved environment when one is passed (plain env + secrets)", () => {
    // The deploy path hands in AppStorage.resolveEnv(app): compose needs the
    // real values on disk to bring the project up, so the stored ciphertext is
    // never what lands in the override.
    const app = appWithCompose({ env: { FOO: "bar" }, secrets: { TOKEN: "enc:v1:aaa:bbb:ccc" } })
    const yaml = override(app, { FOO: "bar", TOKEN: "s3cr3t" })
    expect(yaml).toContain('TOKEN: "s3cr3t"')
    expect(yaml).not.toContain("enc:v1:")
  })

  test("emits volumes under the primary service when present", () => {
    const yaml = override(
      appWithCompose({ volumes: [{ name: "data", mountPath: "/data" }] })
    )
    expect(yaml).toMatch(/volumes:\s+- /m)
    expect(yaml).toContain(":/data")
  })

  test("omits volumes block when list is empty", () => {
    const yaml = override(appWithCompose({ volumes: [] }))
    expect(yaml).not.toMatch(/^ {4}volumes:/m)
  })

  test("escapes backtick-containing rule value by quoting the full string", () => {
    const yaml = override(appWithCompose({ domains: ["x.test"] }))
    const line = yaml.split("\n").find((l) => l.includes("routers.siteio-myapp.rule"))!
    expect(line.trim().startsWith("traefik.http.routers.siteio-myapp.rule:")).toBe(true)
    expect(line).toContain('"Host(`x.test`)"')
  })

  test("escapes newlines in env values as \\n literals", () => {
    const yaml = override(
      appWithCompose({ env: { CERT: "line1\nline2\nline3" } })
    )
    expect(yaml).toContain('CERT: "line1\\nline2\\nline3"')
    // And must NOT contain a raw newline inside a quoted value (would be folded by YAML parsers)
    const certLine = yaml.split("\n").find((l) => l.includes("CERT:"))!
    expect(certLine).toBe('      CERT: "line1\\nline2\\nline3"')
  })

  test("escapes tabs and carriage returns in env values", () => {
    const yaml = override(
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
    expect(() => override(nonCompose)).toThrow(/non-compose/)
  })

  test("readonly volumes emit the :ro suffix", () => {
    const yaml = override(
      appWithCompose({ volumes: [{ name: "data", mountPath: "/data", readonly: true }] })
    )
    const volLine = yaml.split("\n").find((l) => l.trim().startsWith("- ") && l.includes("/data"))!
    expect(volLine).toContain(":/data:ro\"")
  })

  test("absolute-path volumes use the host path directly", () => {
    const yaml = override(
      appWithCompose({ volumes: [{ name: "/srv/shared", mountPath: "/data" }] })
    )
    const volLine = yaml.split("\n").find((l) => l.trim().startsWith("- ") && l.includes("/data"))!
    // Must NOT prepend the dataDir volumes dir
    expect(volLine).not.toContain("volumes/myapp")
    expect(volLine).toContain('"/srv/shared:/data"')
  })

  test("custom dataDir threads through volume path resolution", () => {
    const app = appWithCompose({ volumes: [{ name: "data", mountPath: "/data" }] })
    const yaml = buildOverride(app, "/custom/data/root", app.env)
    const volLine = yaml.split("\n").find((l) => l.trim().startsWith("- ") && l.includes("/data"))!
    expect(volLine).toContain("/custom/data/root/volumes/myapp/data:/data")
  })
})
