import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { UserStore } from "../../lib/agent/user-store.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, ApiResponse, MeInfo, Tenant, UserKeyInfo } from "../../types.ts"

const FRIEND: Tenant = { domain: "friend.com", apiKey: "key-friend", createdAt: "2026-10-19T00:00:00.000Z" }

describe("API: password login and sessions", () => {
  let dataDir: string
  let server: AgentServer
  let users: UserStore

  const call = (path: string, init: RequestInit = {}, host = "localhost", peer = "127.0.0.1") =>
    server.handleRequestForTest(new Request(`http://x${path}`, init), host, peer)
  const login = (username: string, password: string, host = "localhost", ip = "1.1.1.1") =>
    call("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Siteio-UI": "1", "X-Forwarded-For": ip },
      body: JSON.stringify({ username, password }),
    }, host)
  const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!
  const ui = (cookie: string, extra: Record<string, string> = {}) => ({ Cookie: cookie, "X-Siteio-UI": "1", ...extra })

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-users-session-"))
    users = new UserStore(dataDir)
    await users.setAdminPassword("admin password")
    await users.create({ username: "alice", role: "member", password: "alice password" })
    await users.create({ username: "tom", role: "member", tenant: "friend.com", password: "tom password" })
    const config: AgentConfig = {
      apiKey: "god-key", dataDir, domain: "example.com",
      maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
      tenants: [FRIEND],
    }
    server = new AgentServer(config, new FakeRuntime())
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  test("a login sets a strict, host-only, HttpOnly session cookie", async () => {
    const res = await login("alice", "alice password")
    expect(res.status).toBe(200)
    const cookie = res.headers.get("set-cookie")!
    expect(cookie).toStartWith("siteio_session=usr_")
    for (const attr of ["Path=/", "HttpOnly", "Secure", "SameSite=Strict", "Max-Age=604800"]) expect(cookie).toContain(attr)
    expect(cookie).not.toContain("Domain=")
  })

  test("the cookie works only with X-Siteio-UI", async () => {
    const cookie = cookieOf(await login("alice", "alice password"))
    expect((await call("/sites", { headers: ui(cookie) })).status).toBe(200)
    expect((await call("/sites", { headers: { Cookie: cookie } })).status).toBe(401)
  })

  test("X-API-Key wins over a session cookie", async () => {
    const cookie = cookieOf(await login("alice", "alice password"))
    expect((await call("/sites", { headers: ui(cookie, { "X-API-Key": "wrong" }) })).status).toBe(401)
    const info = (await (await call("/agent", { headers: ui(cookie, { "X-API-Key": "god-key" }) })).json()) as ApiResponse<{ dataDir?: string }>
    expect(info.data!.dataDir).toBe(dataDir)
  })

  test("unknown user, wrong password and junk answer the same", async () => {
    const answers = await Promise.all([
      login("nobody", "alice password"),
      login("alice", "wrong password"),
      login("../admin", "x"),
      call("/auth/login", { method: "POST", headers: { "X-Siteio-UI": "1" }, body: "not json" }),
    ])
    for (const res of answers) {
      expect(res.status).toBe(401)
      expect(((await res.json()) as ApiResponse<null>).error).toBe("Invalid username or password")
    }
  })

  test("usernames are case- and space-insensitive at login", async () => {
    expect((await login(" Alice ", "alice password")).status).toBe(200)
  })

  test("a huge password is refused like a wrong one", async () => {
    expect((await login("alice", "x".repeat(1_000_000))).status).toBe(401)
  })

  test("10 failures from one IP answer 429; another IP still logs in", async () => {
    for (let i = 0; i < 10; i++) expect((await login("alice", "wrong password", "localhost", "6.6.6.6")).status).toBe(401)
    expect((await login("alice", "alice password", "localhost", "6.6.6.6")).status).toBe(429)
    expect((await login("alice", "alice password", "localhost", "7.7.7.7")).status).toBe(200)
  })

  test("a burst of parallel wrong logins from one IP is capped at 10 attempts", async () => {
    const answers = await Promise.all(Array.from({ length: 20 }, () => login("alice", "wrong password", "localhost", "8.8.8.8")))
    const statuses = answers.map((r) => r.status)
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(10)
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(10)
    expect((await login("alice", "alice password", "localhost", "9.9.9.9")).status).toBe(200)
  })

  test("a burst of parallel wrong current passwords on /me/password is capped too", async () => {
    const cookie = cookieOf(await login("alice", "alice password"))
    const change = () =>
      call("/me/password", {
        method: "POST",
        headers: ui(cookie, { "Content-Type": "application/json", "X-Forwarded-For": "8.8.4.4" }),
        body: JSON.stringify({ current: "wrong password", new: "new password!" }),
      }, "localhost", "10.0.0.1")
    const statuses = (await Promise.all(Array.from({ length: 20 }, change))).map((r) => r.status)
    expect(statuses.filter((s) => s === 403).length).toBeLessThanOrEqual(10)
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(10)
  })

  test("successful logins don't use up the failure budget", async () => {
    for (let i = 0; i < 15; i++) expect((await login("alice", "alice password", "localhost", "5.5.5.5")).status).toBe(200)
  })

  test("a malformed percent-encoded session cookie is just unauthenticated", async () => {
    expect((await call("/sites", { headers: ui("siteio_session=%E0") })).status).toBe(401)
    const zip = zipSync({ "public/index.html": new TextEncoder().encode("hi") })
    const deployed = await call("/sites/blog", { method: "POST", headers: { "X-API-Key": "god-key", "Content-Type": "application/zip" }, body: zip })
    expect(deployed.status).toBe(200)
    const res = await call("/_siteio/sites/blog/download", { headers: ui("siteio_session=%E0; siteio_edit=%E0") }, "blog.example.com")
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  test("login without X-Siteio-UI is refused (login CSRF): no cookie, not counted", async () => {
    const forged = () =>
      call("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "text/plain", "X-Forwarded-For": "4.4.4.4" },
        body: JSON.stringify({ username: "alice", password: "alice password" }),
      })
    for (let i = 0; i < 12; i++) {
      const res = await forged()
      expect(res.status).toBe(401)
      expect(res.headers.get("set-cookie")).toBeNull()
      expect(((await res.json()) as ApiResponse<null>).error).toBe("Invalid username or password")
    }
    expect((await login("alice", "alice password", "localhost", "4.4.4.4")).status).toBe(200)
  })

  test("a user logs in only on the host of their scope", async () => {
    expect((await login("tom", "tom password")).status).toBe(401)
    expect((await login("alice", "alice password", "api.friend.com")).status).toBe(401)
    expect((await login("tom", "tom password", "api.friend.com")).status).toBe(200)
  })

  test("without an admin yet, login says so", async () => {
    rmSync(join(dataDir, "users", "admin.json"))
    const res = await login("alice", "alice password")
    expect(res.status).toBe(409)
    expect(((await res.json()) as ApiResponse<null>).error).toBe("No users on this server yet")
  })

  test("an expired session is refused", async () => {
    const cookie = cookieOf(await login("alice", "alice password"))
    const file = join(dataDir, "users", "alice.json")
    const user = JSON.parse(readFileSync(file, "utf-8"))
    user.keys[0].expiresAt = "2000-01-01T00:00:00.000Z"
    writeFileSync(file, JSON.stringify(user))
    expect((await call("/sites", { headers: ui(cookie) })).status).toBe(401)
  })

  test("a machine key in the cookie is refused", async () => {
    const { secret } = users.addKey("alice", "machine", "m")
    expect((await call("/sites", { headers: ui(`siteio_session=${secret}`) })).status).toBe(401)
  })

  test("GET /me for a session, the god key and a tenant key", async () => {
    const cookie = cookieOf(await login("alice", "alice password"))
    const me = ((await (await call("/me", { headers: ui(cookie) })).json()) as ApiResponse<MeInfo>).data!
    expect(me).toMatchObject({ username: "alice", role: "member", tenant: null })
    expect(me.currentKeyId).toMatch(/^key_/)
    const god = ((await (await call("/me", { headers: { "X-API-Key": "god-key" } })).json()) as ApiResponse<MeInfo>).data!
    expect(god).toEqual({ username: null, role: "admin", tenant: null, currentKeyId: null })
    const ten = ((await (await call("/me", { headers: { "X-API-Key": "key-friend" } }, "api.friend.com")).json()) as ApiResponse<MeInfo>).data!
    expect(ten).toEqual({ username: null, role: "owner", tenant: "friend.com", currentKeyId: null })
  })

  test("changing your password ends your other sessions, keeps this one and machine keys", async () => {
    const mine = cookieOf(await login("alice", "alice password"))
    const other = cookieOf(await login("alice", "alice password"))
    const { secret: machine } = users.addKey("alice", "machine", "m")
    const change = (current: string, next: string) =>
      call("/me/password", { method: "POST", headers: ui(mine, { "Content-Type": "application/json" }), body: JSON.stringify({ current, new: next }) })
    expect((await change("wrong password", "new password!")).status).toBe(403)
    expect((await change("alice password", "short")).status).toBe(400)
    expect((await change("alice password", "new password!")).status).toBe(200)
    expect((await call("/sites", { headers: ui(mine) })).status).toBe(200)
    expect((await call("/sites", { headers: ui(other) })).status).toBe(401)
    expect((await call("/sites", { headers: { "X-API-Key": machine } })).status).toBe(200)
  })

  test("the god key has no password to change", async () => {
    const res = await call("/me/password", { method: "POST", headers: { "X-API-Key": "god-key" }, body: JSON.stringify({ current: "x", new: "new password!" }) })
    expect(res.status).toBe(400)
  })

  test("own keys: listed without hashes, revoked by id or as current", async () => {
    const cookie = cookieOf(await login("alice", "alice password"))
    const { key, secret } = users.addKey("alice", "machine", "laptop")
    const list = ((await (await call("/me/keys", { headers: ui(cookie) })).json()) as ApiResponse<UserKeyInfo[]>).data!
    expect(list.map((k) => k.kind).sort()).toEqual(["machine", "session"])
    expect(JSON.stringify(list)).not.toContain("hash")
    expect((await call(`/me/keys/${key.id}`, { method: "DELETE", headers: ui(cookie) })).status).toBe(200)
    expect((await call("/sites", { headers: { "X-API-Key": secret } })).status).toBe(401)
    expect((await call("/me/keys/key_00000000", { method: "DELETE", headers: ui(cookie) })).status).toBe(404)
    const second = users.addKey("alice", "machine", "desktop").secret
    expect((await call("/me/keys/current", { method: "DELETE", headers: { "X-API-Key": second } })).status).toBe(200)
    expect((await call("/sites", { headers: { "X-API-Key": second } })).status).toBe(401)
  })

  test("logout ends the session and clears the cookie", async () => {
    const cookie = cookieOf(await login("alice", "alice password"))
    const res = await call("/auth/logout", { method: "POST", headers: ui(cookie) })
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0")
    expect((await call("/sites", { headers: ui(cookie) })).status).toBe(401)
  })
})
