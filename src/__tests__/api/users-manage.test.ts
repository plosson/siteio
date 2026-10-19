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

  test("nobody creates an admin, an owner on the main domain, or a user of an unknown tenant", async () => {
    expect((await add(keys.admin!, { username: "zed", role: "admin" })).status).toBe(400)
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

  test("nobody deletes the admin or resets its password through /users", async () => {
    expect((await call("/users/admin", keys.admin!, { method: "DELETE" })).status).toBe(400)
    expect((await call("/users/admin/password", "god-key", { method: "POST" })).status).toBe(400)
    expect(users.get("admin")).not.toBeNull()
  })

  test("odd names in the path are 404, never an error", async () => {
    for (const path of ["/users/Alice", "/users/a.b", "/users/..%2Fx", "/users/x/y"]) {
      expect((await call(path, keys.admin!, { method: "DELETE" })).status).toBe(404)
    }
  })
})
