import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AgentServer } from "../../lib/agent/server.ts"
import { UserStore } from "../../lib/agent/user-store.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, ApiResponse, Tenant, UserInfo } from "../../types.ts"

const FRIEND: Tenant = { domain: "friend.com", apiKey: "key-friend", createdAt: "2026-10-19T00:00:00.000Z" }
const OTHER: Tenant = { domain: "other.org", apiKey: "key-other", createdAt: "2026-10-19T00:00:00.000Z" }

describe("API: managing users", () => {
  let dataDir: string
  let server: AgentServer
  let users: UserStore
  const keys: Record<string, string> = {}

  const call = (path: string, key: string, init: RequestInit = {}, host = "localhost") =>
    server.handleRequestForTest(
      new Request(`http://x${path}`, { ...init, headers: { "X-API-Key": key, "Content-Type": "application/json" } }),
      host
    )
  const add = (key: string, body: Record<string, unknown>, host = "localhost") =>
    call("/users", key, { method: "POST", body: JSON.stringify(body) }, host)
  const names = async (res: Response) => ((await res.json()) as ApiResponse<UserInfo[]>).data!.map((u) => u.username)

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-users-manage-"))
    users = new UserStore(dataDir)
    await users.setAdminPassword("admin password")
    await users.create({ username: "mia", role: "member", password: "member password" })
    await users.create({ username: "olga", role: "owner", tenant: "friend.com", password: "owner password" })
    await users.create({ username: "oscar", role: "owner", tenant: "other.org", password: "owner password" })
    await users.create({ username: "tom", role: "member", tenant: "friend.com", password: "member password" })
    for (const name of ["admin", "mia", "olga", "tom"]) keys[name] = users.addKey(name, "machine", "t").secret
    const config: AgentConfig = {
      apiKey: "god-key", dataDir, domain: "example.com",
      maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
      tenants: [FRIEND, OTHER],
    }
    server = new AgentServer(config, new FakeRuntime())
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  test("the admin (and the god key) see every user", async () => {
    const all = ["admin", "mia", "olga", "oscar", "tom"]
    expect(await names(await call("/users", keys.admin!))).toEqual(all)
    expect(await names(await call("/users", "god-key"))).toEqual(all)
  })

  test("an owner (and its tenant key) see only their tenant's members", async () => {
    expect(await names(await call("/users", keys.olga!, {}, "api.friend.com"))).toEqual(["tom"])
    expect(await names(await call("/users", "key-friend", {}, "api.friend.com"))).toEqual(["tom"])
  })

  test("a member manages no one", async () => {
    expect((await call("/users", keys.mia!)).status).toBe(404)
    expect((await add(keys.tom!, { username: "zed" }, "api.friend.com")).status).toBe(404)
  })

  test("the admin adds an owner and a member; the password is returned once and works", async () => {
    const res = await add(keys.admin!, { username: "nina", role: "owner", tenant: "friend.com" })
    expect(res.status).toBe(200)
    const { user, password } = ((await res.json()) as ApiResponse<{ user: UserInfo; password: string }>).data!
    expect(user).toMatchObject({ username: "nina", role: "owner", tenant: "friend.com" })
    expect(await users.verifyPassword("nina", password)).not.toBeNull()
    expect((await add(keys.admin!, { username: "max" })).status).toBe(200)
    expect(users.get("max")?.tenant).toBeUndefined()
  })

  test("nobody creates an admin with a tenant, an owner on the main domain, or a user of an unknown tenant", async () => {
    expect((await add(keys.admin!, { username: "zed", role: "admin", tenant: "friend.com" })).status).toBe(400)
    expect((await add(keys.admin!, { username: "zed", role: "owner" })).status).toBe(400)
    expect((await add(keys.admin!, { username: "zed", tenant: "nope.net" })).status).toBe(400)
    expect((await add(keys.admin!, { username: "admin" })).status).toBe(400)
    expect((await add(keys.admin!, { username: "mia" })).status).toBe(400)
    expect(users.get("zed")).toBeNull()
  })

  test("an owner adds members to their own tenant only", async () => {
    expect((await add(keys.olga!, { username: "zed" }, "api.friend.com")).status).toBe(200)
    expect(users.get("zed")?.tenant).toBe("friend.com")
    expect((await add(keys.olga!, { username: "zoe", role: "owner" }, "api.friend.com")).status).toBe(403)
    expect((await add(keys.olga!, { username: "zoe", tenant: "other.org" }, "api.friend.com")).status).toBe(403)
    expect(users.get("zoe")).toBeNull()
  })

  test("an owner can't see, reset or delete owners, main-domain users or the admin (404)", async () => {
    for (const target of ["oscar", "olga", "mia", "admin"]) {
      expect((await call(`/users/${target}`, keys.olga!, { method: "DELETE" }, "api.friend.com")).status).toBe(404)
      expect((await call(`/users/${target}/password`, keys.olga!, { method: "POST" }, "api.friend.com")).status).toBe(404)
    }
    expect(users.get("oscar")).not.toBeNull()
  })

  test("an owner resets and deletes their members", async () => {
    const reset = await call("/users/tom/password", keys.olga!, { method: "POST" }, "api.friend.com")
    const { password } = ((await reset.json()) as ApiResponse<{ password: string }>).data!
    expect(await users.verifyPassword("tom", password)).not.toBeNull()
    expect((await call("/users/tom", keys.olga!, { method: "DELETE" }, "api.friend.com")).status).toBe(200)
    expect((await call("/sites", keys.tom!, {}, "api.friend.com")).status).toBe(401)
  })

  test("a reset ends the target's sessions and keeps its machine keys", async () => {
    const session = users.addKey("tom", "session", "browser").secret
    await call("/users/tom/password", keys.admin!, { method: "POST" })
    expect(users.resolveKey(session)).toBeNull()
    expect(users.resolveKey(keys.tom!)).not.toBeNull()
  })

  test("nobody deletes the bootstrap admin; the god key may reset its password", async () => {
    expect((await call("/users/admin", keys.admin!, { method: "DELETE" })).status).toBe(400)
    expect((await call("/users/admin", "god-key", { method: "DELETE" })).status).toBe(400)
    expect(users.get("admin")).not.toBeNull()
    expect((await call("/users/admin/password", "god-key", { method: "POST", body: JSON.stringify({ password: "fresh admin pw" }) })).status).toBe(200)
    expect(await users.verifyPassword("admin", "fresh admin pw")).not.toBeNull()
  })

  describe("several admins", () => {
    let ann: string
    beforeEach(async () => {
      expect((await add(keys.admin!, { username: "ann", role: "admin", password: "ann password" })).status).toBe(200)
      ann = users.addKey("ann", "machine", "t").secret
    })

    test("a created admin has no tenant and the admin's reach", async () => {
      expect(users.get("ann")).toMatchObject({ role: "admin" })
      expect(users.get("ann")!.tenant).toBeUndefined()
      const info = (await (await call("/agent", ann)).json()) as ApiResponse<{ dataDir?: string }>
      expect(info.data!.dataDir).toBe(dataDir)
      expect((await add(ann, { username: "ben", role: "owner", tenant: "friend.com" })).status).toBe(200)
      expect(await names(await call("/users", ann))).toContain("oscar")
    })

    test("an owner, a tenant key and a member can't create, see, delete or reset an admin", async () => {
      for (const [key, host] of [[keys.olga!, "api.friend.com"], ["key-friend", "api.friend.com"]] as const) {
        expect((await add(key, { username: "zed", role: "admin" }, host)).status).toBe(403)
        expect(users.get("zed")).toBeNull()
        expect(await names(await call("/users", key, {}, host))).not.toContain("ann")
        expect((await call("/users/ann", key, { method: "DELETE" }, host)).status).toBe(404)
        expect((await call("/users/ann/password", key, { method: "POST" }, host)).status).toBe(404)
      }
      expect((await add(keys.mia!, { username: "zed", role: "admin" })).status).toBe(404)
      expect(users.get("ann")).not.toBeNull()
    })

    test("an admin can't delete itself or the bootstrap admin, but deletes another admin", async () => {
      const own = await call("/users/ann", ann, { method: "DELETE" })
      expect(own.status).toBe(400)
      expect(((await own.json()) as ApiResponse<null>).error).toBe("You can't delete your own account")
      const boot = await call("/users/admin", ann, { method: "DELETE" })
      expect(boot.status).toBe(400)
      expect(((await boot.json()) as ApiResponse<null>).error).toBe("The admin account can't be deleted")
      expect((await call("/users/ann", keys.admin!, { method: "DELETE" })).status).toBe(200)
      expect(users.get("ann")).toBeNull()
    })

    test("an admin resets another admin and the bootstrap admin, never itself", async () => {
      expect((await call("/users/ann/password", keys.admin!, { method: "POST" })).status).toBe(200)
      expect((await call("/users/admin/password", ann, { method: "POST" })).status).toBe(200)
      const own = await call("/users/ann/password", ann, { method: "POST" })
      expect(own.status).toBe(400)
      expect(((await own.json()) as ApiResponse<null>).error).toBe("Change your own password on the Account page")
    })
  })

  describe("chosen passwords", () => {
    type Created = { user: UserInfo; password?: string; generated: boolean }
    const data = async (res: Response) => ((await res.json()) as ApiResponse<Created>).data!

    test("a chosen password works and is never echoed; a generated one is returned", async () => {
      const chosen = await data(await add(keys.admin!, { username: "cara", password: "chosen pass 1" }))
      expect(chosen.generated).toBe(false)
      expect(chosen.password).toBeUndefined()
      expect(await users.verifyPassword("cara", "chosen pass 1")).not.toBeNull()
      const made = await data(await add(keys.admin!, { username: "dan" }))
      expect(made.generated).toBe(true)
      expect(await users.verifyPassword("dan", made.password)).not.toBeNull()
    })

    test("a short, long or non-string password is 400 and creates no one", async () => {
      for (const password of ["short", "x".repeat(1025), 5, null, ["a long password"]]) {
        const res = await add(keys.admin!, { username: "eve", password })
        expect(res.status).toBe(400)
        expect(users.get("eve")).toBeNull()
      }
    })

    test("reset takes a chosen password, validates it, and ends sessions but keeps machine keys", async () => {
      const session = users.addKey("tom", "session", "browser").secret
      const res = await call("/users/tom/password", keys.admin!, { method: "POST", body: JSON.stringify({ password: "tom new pass" }) })
      expect(res.status).toBe(200)
      const body = ((await res.json()) as ApiResponse<{ username: string; password?: string; generated: boolean }>).data!
      expect(body).toEqual({ username: "tom", generated: false })
      expect(await users.verifyPassword("tom", "tom new pass")).not.toBeNull()
      expect(users.resolveKey(session)).toBeNull()
      expect(users.resolveKey(keys.tom!)).not.toBeNull()
      for (const password of ["short", 5]) {
        expect((await call("/users/tom/password", keys.admin!, { method: "POST", body: JSON.stringify({ password }) })).status).toBe(400)
      }
      expect(await users.verifyPassword("tom", "tom new pass")).not.toBeNull()
      const gen = ((await (await call("/users/tom/password", keys.admin!, { method: "POST" })).json()) as ApiResponse<{ password?: string; generated: boolean }>).data!
      expect(gen.generated).toBe(true)
      expect(gen.password).toHaveLength(24)
    })
  })

  test("GET /agent lists the tenants, sorted, for the admin only", async () => {
    const tenants = async (key: string, host = "localhost") =>
      ((await (await call("/agent", key, {}, host)).json()) as ApiResponse<Record<string, unknown>>).data!.tenants
    expect(await tenants(keys.admin!)).toEqual(["friend.com", "other.org"])
    expect(await tenants("god-key")).toEqual(["friend.com", "other.org"])
    expect(await tenants(keys.mia!)).toBeUndefined()
    expect(await tenants("key-friend", "api.friend.com")).toBeUndefined()
    expect(await tenants(keys.olga!, "api.friend.com")).toBeUndefined()
  })

  test("odd names in the path are 404, never an error", async () => {
    for (const path of ["/users/Alice", "/users/a.b", "/users/..%2Fx", "/users/x/y"]) {
      expect((await call(path, keys.admin!, { method: "DELETE" })).status).toBe(404)
    }
  })
})
