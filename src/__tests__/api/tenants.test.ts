import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { SiteStorage } from "../../lib/agent/storage.ts"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import { loadAgentConfig, updateAgentConfig } from "../../config/agent.ts"
import { encodeToken } from "../../utils/token.ts"
import type { AgentConfig, ApiResponse, SiteInfo, Tenant } from "../../types.ts"

const A: Tenant = { domain: "friend.com", apiKey: "key-a", createdAt: "2026-10-08T00:00:00.000Z" }
const B: Tenant = { domain: "other.org", apiKey: "key-b", createdAt: "2026-10-08T00:00:00.000Z" }
const C: Tenant = { domain: "vaults.net", apiKey: "key-c", createdAt: "2026-10-09T00:00:00.000Z", apps: true }

function makeServer(dataDir: string, runtime: FakeRuntime, extra: Partial<AgentConfig> = {}): AgentServer {
  const config: AgentConfig = {
    apiKey: "god-key", dataDir, domain: "example.com",
    maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
    tenants: [A, B, C],
    ...extra,
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
  // api.friend.com = tenant A, api.other.org = tenant B,
  // api.vaults.net = tenant C (apps allowed).
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

  describe("tenant domains, renames, share links", () => {
    const json = (key: string) => as(key, { "Content-Type": "application/json" })
    const setDomains = (name: string, domains: string[], key: string, host: string) =>
      req(`/sites/${name}/domains`, { method: "PATCH", headers: json(key), body: JSON.stringify({ domains }) }, host)

    test("a tenant may use its own apex and unrelated domains", async () => {
      await deploy("blog", "key-a", "api.friend.com")
      const res = await setDomains("blog", ["friend.com", "www.unrelated.net"], "key-a", "api.friend.com")
      expect(res.status).toBe(200)
    })

    test("a tenant can't take another scope's apex or any platform hostname", async () => {
      await deploy("blog", "key-a", "api.friend.com")
      for (const d of ["other.org", "example.com", "x.other.org", "x.example.com", "api.friend.com", "shop.friend.com"]) {
        const res = await setDomains("blog", [d], "key-a", "api.friend.com")
        expect(res.status).toBe(400)
      }
    })

    test("a domain clash does not reveal the other scope's site name", async () => {
      await deploy("secret-site", "god-key", "localhost")
      await setDomains("secret-site", ["www.shared.net"], "god-key", "localhost")
      await deploy("blog", "key-a", "api.friend.com")
      const res = await setDomains("blog", ["www.shared.net"], "key-a", "api.friend.com")
      expect(res.status).toBe(400)
      expect(((await res.json()) as ApiResponse<null>).error).not.toContain("secret-site")
    })

    test("a tenant rename stays inside the tenant", async () => {
      await deploy("blog", "key-a", "api.friend.com")
      runtime.containerExistsReturn = true
      const res = await req("/sites/blog/rename", {
        method: "PATCH", headers: json("key-a"), body: JSON.stringify({ newSubdomain: "shop" }),
      }, "api.friend.com")
      expect(res.status).toBe(200)
      expect(((await res.json()) as ApiResponse<SiteInfo>).data!.url).toBe("https://shop.friend.com")
      const names = runtime.callsOf("run").map((c) => (c.args[0] as { name: string }).name)
      expect(names.at(-1)).toBe("shop--friend-com")
    })

    test("the god key renaming a tenant site keeps it on the tenant domain", async () => {
      await deploy("blog", "key-a", "api.friend.com")
      runtime.containerExistsReturn = true
      const res = await req("/sites/blog--friend-com/rename", {
        method: "PATCH", headers: json("god-key"), body: JSON.stringify({ newSubdomain: "shop" }),
      })
      expect(res.status).toBe(200)
      expect(((await res.json()) as ApiResponse<SiteInfo>).data!.url).toBe("https://shop.friend.com")
      const names = runtime.callsOf("run").map((c) => (c.args[0] as { name: string }).name)
      expect(names.at(-1)).toBe("shop--friend-com")
    })

    test("a rename can't forge a key or leave the tenant", async () => {
      await deploy("blog", "key-a", "api.friend.com")
      for (const newSubdomain of ["x--other-org", "api", "Shop"]) {
        const res = await req("/sites/blog/rename", {
          method: "PATCH", headers: json("key-a"), body: JSON.stringify({ newSubdomain }),
        }, "api.friend.com")
        expect(res.status).toBe(400)
      }
    })

    test("a tenant share link lives on the tenant host and stays in its scope", async () => {
      await deploy("blog", "key-a", "api.friend.com")
      await deploy("blog", "god-key", "localhost")
      const minted = await req("/sites/blog/grants", { method: "POST", headers: json("key-a"), body: "{}" }, "api.friend.com")
      const { url, code } = ((await minted.json()) as ApiResponse<{ url: string; code: string }>).data!
      expect(url).toBe("https://blog.friend.com/mcp")

      const ok = await req("/_siteio/sites/blog/download", { headers: as(code) }, "blog.friend.com")
      expect(ok.status).toBe(200)
      const viaApi = await req("/sites/blog/download", { headers: as(code) }, "api.friend.com")
      expect(viaApi.status).toBe(200)

      // Same bare name, other scopes: refused.
      expect((await req("/_siteio/sites/blog/download", { headers: as(code) }, "blog.example.com")).status).toBe(403)
      expect((await req("/sites/blog/download", { headers: as(code) }, "api.other.org")).status).toBe(403)
      expect((await req("/sites/blog/download", { headers: as(code) })).status).toBe(403)
    })

    test("the god key sees the internal key in a freshly minted grant, like in the listing", async () => {
      await deploy("blog", "key-a", "api.friend.com")
      const res = await req("/sites/blog--friend-com/grants", { method: "POST", headers: json("god-key"), body: "{}" })
      expect(((await res.json()) as ApiResponse<{ grant: { site: string } }>).data!.grant.site).toBe("blog--friend-com")
    })

    test("deleting a site revokes its share codes for a re-created site", async () => {
      await deploy("blog", "key-a", "api.friend.com")
      const minted = await req("/sites/blog/grants", { method: "POST", headers: json("key-a"), body: "{}" }, "api.friend.com")
      const { code } = ((await minted.json()) as ApiResponse<{ code: string }>).data!
      expect((await req("/_siteio/sites/blog/download", { headers: as(code) }, "blog.friend.com")).status).toBe(200)

      expect((await req("/sites/blog", { method: "DELETE", headers: as("key-a") }, "api.friend.com")).status).toBe(200)
      await deploy("blog", "key-a", "api.friend.com")
      const old = await req("/_siteio/sites/blog/download", { headers: as(code) }, "blog.friend.com")
      expect([401, 403]).toContain(old.status)
    })

    test("the consent page of a tenant site shows the bare name, not the internal key", async () => {
      await deploy("blog", "key-a", "api.friend.com")
      const qs = new URLSearchParams({
        response_type: "code", client_id: "x", redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_challenge: "c", code_challenge_method: "S256", state: "s",
      })
      const res = await req(`/mcp/oauth/authorize?${qs}`, {}, "blog.friend.com")
      const html = await res.text()
      expect(html).toContain("blog")
      expect(html).not.toContain("blog--friend-com")
    })

    test("listed share links show the tenant's bare site name", async () => {
      await deploy("blog", "key-a", "api.friend.com")
      await req("/sites/blog/grants", { method: "POST", headers: json("key-a"), body: "{}" }, "api.friend.com")
      const res = await req("/sites/blog/grants", { headers: as("key-a") }, "api.friend.com")
      const grants = ((await res.json()) as ApiResponse<Array<{ site: string }>>).data!
      expect(grants.map((g) => g.site)).toEqual(["blog"])
    })

    test("/agent shows a tenant only its own domain", async () => {
      await deploy("blog", "key-a", "api.friend.com")
      await deploy("shop", "god-key", "localhost")
      const res = await req("/agent", { headers: as("key-a") }, "api.friend.com")
      const info = ((await res.json()) as ApiResponse<Record<string, unknown>>).data!
      expect(info.domain).toBe("friend.com")
      expect(info.siteCount).toBe(1)
      expect(info.appsEnabled).toBe(false)
      expect(info.dataDir).toBeUndefined()
      expect(info.email).toBeUndefined()
    })

    test("/agent reports apps only to a tenant allowed to run them", async () => {
      const info = async (key: string, host: string) =>
        ((await (await req("/agent", { headers: as(key) }, host)).json()) as ApiResponse<Record<string, unknown>>).data!
      expect((await info("key-c", "api.vaults.net")).appsEnabled).toBe(true)
      expect((await info("key-c", "api.vaults.net")).appCount).toBe(0)
      expect((await info("key-a", "api.friend.com")).appsEnabled).toBe(false)
    })

    test("an agent with apps disabled reports them off to every tenant", async () => {
      server = makeServer(dataDir, runtime, { appsEnabled: false })
      const res = await req("/agent", { headers: as("key-c") }, "api.vaults.net")
      expect(((await res.json()) as ApiResponse<Record<string, unknown>>).data!.appsEnabled).toBe(false)
    })

    test("a tenant can't download or read logs of another tenant's site", async () => {
      await deploy("blog", "key-b", "api.other.org")
      for (const sub of ["download", "logs"]) {
        expect((await req(`/sites/blog/${sub}`, { headers: as("key-a") }, "api.friend.com")).status).toBe(404)
      }
    })
  })

  describe("POST /tenants", () => {
    const add = (body: unknown, key = "god-key", host = "localhost") =>
      req("/tenants", {
        method: "POST",
        headers: as(key, { "Content-Type": "application/json" }),
        body: typeof body === "string" ? body : JSON.stringify(body),
      }, host)
    const errorOf = async (res: Response) => ((await res.json()) as ApiResponse<null>).error

    test("a tenant is sites-only unless added with apps: true", async () => {
      const plain = await add({ domain: "third.net" })
      expect(plain.status).toBe(200)
      expect(((await plain.json()) as ApiResponse<{ apps: boolean }>).data!.apps).toBe(false)
      const withApps = await add({ domain: "fourth.net", apps: true })
      expect(withApps.status).toBe(200)
      expect(((await withApps.json()) as ApiResponse<{ apps: boolean }>).data!.apps).toBe(true)
      const stored = loadAgentConfig(dataDir).tenants!
      expect(stored.find((t) => t.domain === "third.net")!.apps).toBeUndefined()
      expect(stored.find((t) => t.domain === "fourth.net")!.apps).toBe(true)
    })

    test("refuses an apps flag that is not a boolean", async () => {
      for (const apps of ["yes", "true", 1, null, {}]) {
        expect((await add({ domain: "third.net", apps })).status).toBe(400)
      }
      expect(loadAgentConfig(dataDir).tenants).toBeUndefined()
    })

    test("only the god key on the primary api host may add a tenant", async () => {
      expect((await add({ domain: "third.net" }, "key-a", "api.friend.com")).status).toBe(404)
      expect((await add({ domain: "third.net" }, "key-a")).status).toBe(401)
      expect((await add({ domain: "third.net" }, "god-key", "api.friend.com")).status).toBe(401)
      expect((await add({ domain: "third.net" }, "nope")).status).toBe(401)
      expect(loadAgentConfig(dataDir).tenants).toBeUndefined()
    })

    test("a share code can't add a tenant", async () => {
      await deploy("blog", "god-key", "localhost")
      const minted = await req("/sites/blog/grants", {
        method: "POST",
        headers: as("god-key", { "Content-Type": "application/json" }),
        body: JSON.stringify({}),
      })
      const { code } = ((await minted.json()) as ApiResponse<{ code: string }>).data!
      expect((await add({ domain: "third.net" }, code)).status).toBe(403)
      expect(loadAgentConfig(dataDir).tenants).toBeUndefined()
    })

    test("refuses malformed bodies", async () => {
      for (const body of ["not json", "null", {}, { domain: 42 }, { domain: ["third.net"] }]) {
        const res = await add(body)
        expect(res.status).toBe(400)
      }
    })

    test("refuses invalid and overlapping domains", async () => {
      for (const domain of ["", "nodot", "third.net/x", "*.third.net", "example.com", "x.example.com", "friend.com", "sub.friend.com", "com"]) {
        expect((await add({ domain })).status).toBe(400)
      }
      expect(loadAgentConfig(dataDir).tenants).toBeUndefined()
    })

    test("refuses a domain a site already uses as a custom domain", async () => {
      await deploy("shop", "god-key", "localhost")
      await req("/sites/shop/domains", {
        method: "PATCH",
        headers: as("god-key", { "Content-Type": "application/json" }),
        body: JSON.stringify({ domains: ["www.third.net"] }),
      })
      const res = await add({ domain: "third.net" })
      expect(res.status).toBe(400)
      expect(await errorOf(res)).toBe("Site 'shop' already uses a domain under 'third.net'")
    })

    test("adding twice is refused and keeps the first key", async () => {
      const first = ((await (await add({ domain: "Third.NET " })).json()) as ApiResponse<{ apiKey: string }>).data!
      const again = await add({ domain: "third.net" })
      expect(again.status).toBe(400)
      expect(loadAgentConfig(dataDir).tenants!.map((t) => [t.domain, t.apiKey])).toEqual([["third.net", first.apiKey]])
    })

    test("the new tenant is served at once and persisted", async () => {
      const res = await add({ domain: "third.net" })
      expect(res.status).toBe(200)
      const out = ((await res.json()) as ApiResponse<{ domain: string; apiUrl: string; apiKey: string; token: string }>).data!
      expect(out.domain).toBe("third.net")
      expect(out.apiUrl).toBe("https://api.third.net")
      expect(out.apiKey).not.toBe("god-key")
      expect(out.token).toBe(encodeToken("https://api.third.net", out.apiKey))

      const site = await deploy("blog", out.apiKey, "api.third.net")
      expect(site.status).toBe(200)
      expect(((await site.json()) as ApiResponse<SiteInfo>).data!.url).toBe("https://blog.third.net")
      expect((await req("/sites", { headers: as(out.apiKey) }, "api.friend.com")).status).toBe(401)

      const persisted = loadAgentConfig(dataDir).tenants!
      expect(persisted.map((t) => t.domain)).toEqual(["third.net"])
      expect(persisted[0]!.apiKey).toBe(out.apiKey)
    })

    test("tenants added on-box since start are kept on disk", async () => {
      const onBox: Tenant = { domain: "pending.io", apiKey: "key-p", createdAt: "" }
      updateAgentConfig(dataDir, { tenants: [onBox] })
      await add({ domain: "third.net" })
      expect(loadAgentConfig(dataDir).tenants!.map((t) => t.domain)).toEqual(["pending.io", "third.net"])
    })
  })
})

describe("API: primary sites whose name contains --", () => {
  let dataDir: string
  let server: AgentServer
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-dashsite-"))
    server = new AgentServer({
      apiKey: "god-key", dataDir, domain: "example.com",
      maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
    }, new FakeRuntime())
    new SiteStorage(dataDir).create({
      name: "my--site", domains: [], pocketbaseVersion: "0.0.0", status: "running", size: 0, version: 1,
    })
    mkdirSync(join(dataDir, "pocket-code", "my--site", "public"), { recursive: true })
    writeFileSync(join(dataDir, "pocket-code", "my--site", "public", "index.html"), "<h1>x</h1>")
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  test("MCP discovery and share codes still work with no tenants", async () => {
    const meta = await server.handleRequestForTest(new Request("http://x/.well-known/oauth-protected-resource"), "my--site.example.com")
    expect(meta.status).toBe(200)

    const minted = await server.handleRequestForTest(new Request("http://x/sites/my--site/grants", {
      method: "POST", headers: { "X-API-Key": "god-key", "Content-Type": "application/json" }, body: "{}",
    }), "localhost")
    const { code } = ((await minted.json()) as ApiResponse<{ code: string }>).data!
    const dl = await server.handleRequestForTest(new Request("http://x/sites/my--site/download", { headers: { "X-API-Key": code } }), "localhost")
    expect(dl.status).toBe(200)
  })
})
