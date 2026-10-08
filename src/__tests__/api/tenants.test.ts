import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, ApiResponse, SiteInfo, Tenant } from "../../types.ts"

const A: Tenant = { domain: "friend.com", apiKey: "key-a", createdAt: "2026-10-08T00:00:00.000Z" }
const B: Tenant = { domain: "other.org", apiKey: "key-b", createdAt: "2026-10-08T00:00:00.000Z" }

function makeServer(dataDir: string, runtime: FakeRuntime): AgentServer {
  const config: AgentConfig = {
    apiKey: "god-key", dataDir, domain: "example.com",
    maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
    tenants: [A, B],
  }
  return new AgentServer(config, runtime)
}

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)])))

describe("API: tenants", () => {
  let dataDir: string
  let runtime: FakeRuntime
  let server: AgentServer

  // `host` picks the scope: localhost / api.example.com = primary,
  // api.friend.com = tenant A, api.other.org = tenant B.
  const req = (path: string, init: RequestInit = {}, host = "localhost") =>
    server.handleRequestForTest(new Request(`http://x${path}`, init), host)
  const as = (key: string, extra: Record<string, string> = {}) => ({ "X-API-Key": key, ...extra })
  const deploy = (name: string, key: string, host: string, html = "<h1>hi</h1>") =>
    req(`/sites/${name}`, {
      method: "POST",
      headers: as(key, { "Content-Type": "application/zip" }),
      body: zip({ "public/index.html": html }),
    }, host)

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-tenants-"))
    runtime = new FakeRuntime()
    server = makeServer(dataDir, runtime)
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  describe("site hosts", () => {
    test("a tenant platform host resolves for the MCP surface", async () => {
      const res = await req("/.well-known/oauth-protected-resource", {}, "blog.friend.com")
      expect(res.status).toBe(200)
      expect(JSON.stringify(await res.json())).toContain("https://blog.friend.com")
    })

    test("a tenant key smuggled through the primary domain is not a site host", async () => {
      const res = await req("/.well-known/oauth-protected-resource", {}, "blog--friend-com.example.com")
      expect(res.status).toBe(404)
    })

    test("unknown base domains are not site hosts", async () => {
      const res = await req("/.well-known/oauth-protected-resource", {}, "blog.evil.com")
      expect(res.status).toBe(404)
    })
  })
})
