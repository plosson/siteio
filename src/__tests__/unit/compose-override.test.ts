import { describe, test, expect } from "bun:test"
import { buildOverride } from "../../lib/agent/compose-override"
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

describe("Unit: buildOverride", () => {
  test("emits services.<primary>.networks with siteio-network", () => {
    const yaml = buildOverride(appWithCompose())
    expect(yaml).toContain("services:")
    expect(yaml).toMatch(/^ {2}web:/m)
    expect(yaml).toMatch(/networks:\s+- siteio-network/m)
  })

  test("declares siteio-network as external", () => {
    const yaml = buildOverride(appWithCompose())
    expect(yaml).toMatch(/^networks:\s+siteio-network:\s+external: true/ms)
  })

  test("emits Traefik labels for a single domain", () => {
    const yaml = buildOverride(appWithCompose({ domains: ["app.example.com"] }))
    expect(yaml).toContain('traefik.enable: "true"')
    expect(yaml).toContain('traefik.docker.network: "siteio-network"')
    expect(yaml).toContain('traefik.http.routers.siteio-myapp.entrypoints: "websecure"')
    expect(yaml).toContain('traefik.http.routers.siteio-myapp.tls.certresolver: "letsencrypt"')
    expect(yaml).toContain('traefik.http.services.siteio-myapp.loadbalancer.server.port: "3000"')
    expect(yaml).toContain('traefik.http.routers.siteio-myapp.rule: "Host(`app.example.com`)"')
  })

  test("ORs multiple domains with `||`", () => {
    const yaml = buildOverride(appWithCompose({ domains: ["a.example.com", "b.example.com"] }))
    expect(yaml).toContain(
      'traefik.http.routers.siteio-myapp.rule: "Host(`a.example.com`) || Host(`b.example.com`)"'
    )
  })

  test("emits env vars as a map under the primary service", () => {
    const yaml = buildOverride(appWithCompose({ env: { FOO: "bar", DATABASE_URL: "postgres://db/x" } }))
    expect(yaml).toMatch(/environment:\s+FOO: "bar"/m)
    expect(yaml).toContain('DATABASE_URL: "postgres://db/x"')
  })

  test("omits environment block when env is empty", () => {
    const yaml = buildOverride(appWithCompose({ env: {} }))
    expect(yaml).not.toContain("environment:")
  })

  test("emits volumes under the primary service when present", () => {
    const yaml = buildOverride(
      appWithCompose({ volumes: [{ name: "data", mountPath: "/data" }] })
    )
    expect(yaml).toMatch(/volumes:\s+- /m)
    expect(yaml).toContain(":/data")
  })

  test("omits volumes block when list is empty", () => {
    const yaml = buildOverride(appWithCompose({ volumes: [] }))
    expect(yaml).not.toMatch(/^ {4}volumes:/m)
  })

  test("escapes backtick-containing rule value by quoting the full string", () => {
    const yaml = buildOverride(appWithCompose({ domains: ["x.test"] }))
    const line = yaml.split("\n").find((l) => l.includes("routers.siteio-myapp.rule"))!
    expect(line.trim().startsWith("traefik.http.routers.siteio-myapp.rule:")).toBe(true)
    expect(line).toContain('"Host(`x.test`)"')
  })
})
