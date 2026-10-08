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

  describe("tenant API keys", () => {
    test("a tenant deploys under a bare name on its own domain", async () => {
      const res = await deploy("blog", "key-a", "api.friend.com")
      expect(res.status).toBe(200)
      const info = ((await res.json()) as ApiResponse<SiteInfo>).data!
      expect(info.name).toBe("blog")
      expect(info.url).toBe("https://blog.friend.com")
      expect(runtime.callsOf("run").map((c) => (c.args[0] as { name: string }).name)).toEqual(["blog--friend-com"])
    })

    test("the same name coexists in the primary domain and in a tenant", async () => {
      expect((await deploy("blog", "god-key", "localhost")).status).toBe(200)
      expect((await deploy("blog", "key-a", "api.friend.com")).status).toBe(200)

      const mine = (await (await req("/sites", { headers: as("key-a") }, "api.friend.com")).json()) as ApiResponse<SiteInfo[]>
      expect(mine.data!.map((s) => [s.name, s.url])).toEqual([["blog", "https://blog.friend.com"]])

      const all = (await (await req("/sites", { headers: as("god-key") })).json()) as ApiResponse<SiteInfo[]>
      expect(all.data!.map((s) => s.name).sort()).toEqual(["blog", "blog--friend-com"])
    })

    test("a tenant key works only on its own api host", async () => {
      for (const host of ["localhost", "api.example.com", "api.other.org"]) {
        const res = await req("/sites", { headers: as("key-a") }, host)
        expect(res.status).toBe(401)
      }
    })

    test("the god key is refused on a tenant api host", async () => {
      expect((await req("/sites", { headers: as("god-key") }, "api.friend.com")).status).toBe(401)
    })

    test("an unknown api host is not served", async () => {
      expect((await req("/sites", { headers: as("god-key") }, "api.evil.com")).status).toBe(404)
    })

    test("a tenant can't reach another scope's site by forging a key", async () => {
      await deploy("blog", "key-b", "api.other.org")
      await deploy("shop", "god-key", "localhost")
      for (const path of ["/sites/blog--other-org", "/sites/blog--other-org/download", "/sites/shop--x/logs"]) {
        expect((await req(path, { headers: as("key-a") }, "api.friend.com")).status).toBe(404)
      }
      expect((await req("/sites/shop", { headers: as("key-a") }, "api.friend.com")).status).toBe(404)
      expect((await req("/sites/blog", { headers: as("key-a") }, "api.friend.com")).status).toBe(404)
    })

    test("a tenant can't delete another tenant's site of the same name", async () => {
      await deploy("blog", "key-b", "api.other.org")
      const res = await req("/sites/blog", { method: "DELETE", headers: as("key-a") }, "api.friend.com")
      expect(res.status).toBe(404)
      const b = await req("/sites/blog", { headers: as("key-b") }, "api.other.org")
      expect(b.status).toBe(200)
    })

    test("apps, chat and edit links are not available to a tenant", async () => {
      await deploy("blog", "key-a", "api.friend.com")
      const apps = await req("/apps", { headers: as("key-a") }, "api.friend.com")
      expect(apps.status).toBe(403)
      expect(((await apps.json()) as ApiResponse<null>).error).toBe("Apps are disabled on this agent")
      for (const path of ["/sites/blog/chat", "/sites/blog/edit-link"]) {
        expect((await req(path, { method: "POST", headers: as("key-a") }, "api.friend.com")).status).toBe(404)
      }
    })

    test("the download filename is the tenant's bare name", async () => {
      await deploy("blog", "key-a", "api.friend.com")
      const res = await req("/sites/blog/download", { headers: as("key-a") }, "api.friend.com")
      expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="blog.zip"')
    })

    test("new names may not contain -- in any scope", async () => {
      expect((await deploy("a--b", "god-key", "localhost")).status).toBe(400)
      expect((await deploy("a--b", "key-a", "api.friend.com")).status).toBe(404)
      const app = await req("/apps", {
        method: "POST",
        headers: as("god-key", { "Content-Type": "application/json" }),
        body: JSON.stringify({ name: "blog--friend-com", image: "nginx", internalPort: 80 }),
      })
      expect(app.status).toBe(400)
    })

    test("a tenant addressing an invalid name gets 404, not a 500", async () => {
      for (const name of ["blog-", "-blog"]) {
        expect((await req(`/sites/${name}`, { headers: as("key-a") }, "api.friend.com")).status).toBe(404)
      }
    })

    test("the operator can still manage a tenant site by its key", async () => {
      await deploy("blog", "key-a", "api.friend.com")
      const res = await req("/sites/blog--friend-com", { headers: as("god-key") })
      expect(res.status).toBe(200)
      const info = ((await res.json()) as ApiResponse<SiteInfo>).data!
      expect(info.name).toBe("blog--friend-com")
      expect(info.url).toBe("https://blog.friend.com")
    })
  })
})
