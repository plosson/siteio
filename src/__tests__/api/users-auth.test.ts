import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { SiteStorage } from "../../lib/agent/storage.ts"
import { UserStore } from "../../lib/agent/user-store.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, ApiResponse, SiteInfo, Tenant } from "../../types.ts"

const FRIEND: Tenant = { domain: "friend.com", apiKey: "key-friend", createdAt: "2026-10-19T00:00:00.000Z" }
const VAULTS: Tenant = { domain: "vaults.net", apiKey: "key-vaults", createdAt: "2026-10-19T00:00:00.000Z", apps: true }

const zip = (html = "<h1>hi</h1>") => zipSync({ "public/index.html": new TextEncoder().encode(html) })

describe("API: user keys", () => {
  let dataDir: string
  let server: AgentServer
  let users: UserStore
  const keys: Record<string, string> = {}

  const makeServer = (tenants: Tenant[]) => {
    const config: AgentConfig = {
      apiKey: "god-key", dataDir, domain: "example.com",
      maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
      tenants,
    }
    return new AgentServer(config, new FakeRuntime())
  }
  const req = (path: string, key: string, init: RequestInit = {}, host = "localhost") =>
    server.handleRequestForTest(
      new Request(`http://x${path}`, { ...init, headers: { "X-API-Key": key, ...(init.headers as Record<string, string>) } }),
      host
    )
  const deploy = (name: string, key: string, host = "localhost", extra: Record<string, string> = {}) =>
    req(`/sites/${name}`, key, { method: "POST", headers: { "Content-Type": "application/zip", ...extra }, body: zip() }, host)
  const createApp = (key: string, body: Record<string, unknown>) =>
    req("/apps", key, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-users-auth-"))
    users = new UserStore(dataDir)
    await users.setAdminPassword("admin password")
    await users.create({ username: "mia", role: "member", password: "member password" })
    await users.create({ username: "olga", role: "owner", tenant: "friend.com", password: "owner password" })
    await users.create({ username: "tom", role: "member", tenant: "friend.com", password: "member password" })
    for (const name of ["admin", "mia", "olga", "tom"]) keys[name] = users.addKey(name, "machine", `${name}@test`).secret
    server = makeServer([FRIEND, VAULTS])
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  describe("the admin key", () => {
    test("works like the god key on the main host", async () => {
      expect((await deploy("blog", keys.admin!)).status).toBe(200)
      expect((await deploy("blog", keys.tom!, "api.friend.com")).status).toBe(200)
      const list = (await (await req("/sites", keys.admin!)).json()) as ApiResponse<SiteInfo[]>
      expect(list.data!.map((s) => s.name).sort()).toEqual(["blog", "blog--friend-com"])
      expect((await req("/agent", keys.admin!)).status).toBe(200)
      expect(((await (await req("/agent", keys.admin!)).json()) as ApiResponse<{ dataDir?: string }>).data!.dataDir).toBe(dataDir)
    })

    test("is refused on a tenant host", async () => {
      expect((await req("/sites", keys.admin!, {}, "api.friend.com")).status).toBe(401)
    })
  })

  describe("a main-domain member", () => {
    test("deploys main-domain sites and never sees tenant sites", async () => {
      expect((await deploy("blog", keys.mia!)).status).toBe(200)
      expect((await deploy("shop", keys.tom!, "api.friend.com")).status).toBe(200)
      const list = (await (await req("/sites", keys.mia!)).json()) as ApiResponse<SiteInfo[]>
      expect(list.data!.map((s) => s.name)).toEqual(["blog"])
      expect((await req("/sites/shop--friend-com", keys.mia!)).status).toBe(404)
    })

    test("can't reach operator routes", async () => {
      expect((await req("/tenants", keys.mia!, { method: "POST", body: "{}" })).status).toBe(404)
    })

    test("gets a scoped GET /agent without host settings", async () => {
      await deploy("shop", keys.tom!, "api.friend.com")
      const info = ((await (await req("/agent", keys.mia!)).json()) as ApiResponse<Record<string, unknown>>).data!
      expect(info.dataDir).toBeUndefined()
      expect(info.email).toBeUndefined()
      expect(info.domain).toBe("example.com")
      expect(info.siteCount).toBe(0)
    })

    test("gets the tenant app restrictions", async () => {
      const base = { name: "web", image: "nginx", internalPort: 80 }
      expect((await createApp(keys.mia!, { ...base, composeContent: "services: {}", primaryService: "web" })).status).toBe(400)
      expect((await createApp(keys.mia!, { ...base, volumes: [{ name: "/etc", mountPath: "/x" }] })).status).toBe(400)
      expect((await createApp(keys.mia!, { name: "web", git: { repoUrl: "file:///root" }, internalPort: 80 })).status).toBe(400)
      expect((await createApp(keys.mia!, { ...base, env: { DOCKER_HOST: "tcp://x" } })).status).toBe(400)
      expect((await createApp(keys.mia!, { ...base, domains: ["anything.example.com"] })).status).toBe(400)
      expect((await createApp(keys.mia!, base)).status).toBe(200)
    })

    test("reaches the chat routes; a tenant user doesn't", async () => {
      await deploy("blog", keys.mia!)
      expect((await req("/sites/blog/chat", keys.mia!)).status).toBe(200)
      await deploy("blog", keys.tom!, "api.friend.com")
      expect((await req("/sites/blog/chat", keys.tom!, {}, "api.friend.com")).status).toBe(404)
    })

    test("is refused on a tenant host", async () => {
      expect((await req("/sites", keys.mia!, {}, "api.friend.com")).status).toBe(401)
    })
  })

  describe("tenant users", () => {
    test("work on their own tenant host only", async () => {
      expect((await deploy("blog", keys.olga!, "api.friend.com")).status).toBe(200)
      expect((await req("/sites", keys.olga!)).status).toBe(401)
      expect((await req("/sites", keys.olga!, {}, "api.vaults.net")).status).toBe(401)
    })

    test("a user of a removed tenant is no one", async () => {
      server = makeServer([VAULTS])
      expect((await req("/sites", keys.tom!)).status).toBe(401)
      expect((await req("/sites", keys.tom!, {}, "api.vaults.net")).status).toBe(401)
    })
  })

  test("a revoked key is refused on the next request", async () => {
    expect((await req("/sites", keys.mia!)).status).toBe(200)
    const id = users.get("mia")!.keys[0]!.id
    users.revokeKey("mia", id)
    expect((await req("/sites", keys.mia!)).status).toBe(401)
  })

  test("a session secret is not accepted as an API key", async () => {
    const { secret } = users.addKey("mia", "session", "browser")
    expect((await req("/sites", secret)).status).toBe(401)
  })

  test("the god key and tenant keys still work", async () => {
    expect((await req("/sites", "god-key")).status).toBe(200)
    expect((await req("/sites", "key-friend", {}, "api.friend.com")).status).toBe(200)
  })

  test("deploys are recorded under the username, whatever X-Siteio-User says", async () => {
    await deploy("blog", keys.mia!, "localhost", { "X-Siteio-User": "mallory" })
    expect(new SiteStorage(dataDir).get("blog")!.deployedBy).toBe("mia")
    await deploy("blog", "god-key", "localhost", { "X-Siteio-User": "pierre" })
    expect(new SiteStorage(dataDir).get("blog")!.deployedBy).toBe("pierre")
  })
})
