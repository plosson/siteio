import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AgentServer } from "../../lib/agent/server.ts"
import { UserStore } from "../../lib/agent/user-store.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, ApiResponse, HostStats, Tenant } from "../../types.ts"

const FRIEND: Tenant = { domain: "friend.com", apiKey: "key-friend", createdAt: "2026-11-19T00:00:00.000Z", apps: true }

describe("API: GET /stats", () => {
  let dataDir: string
  let server: AgentServer
  const keys: Record<string, string> = {}

  const get = (path: string, key?: string, host = "localhost") =>
    server.handleRequestForTest(new Request(`http://x${path}`, { headers: key ? { "X-API-Key": key } : {} }), host)

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-host-stats-api-"))
    const users = new UserStore(dataDir)
    await users.setAdminPassword("admin password")
    await users.create({ username: "mia", role: "member", password: "member password" })
    await users.create({ username: "olga", role: "owner", tenant: "friend.com", password: "owner password" })
    for (const name of ["admin", "mia", "olga"]) keys[name] = users.addKey(name, "machine", "t").secret
    const config: AgentConfig = {
      apiKey: "god-key", dataDir, domain: "example.com",
      maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
      tenants: [FRIEND],
    }
    server = new AgentServer(config, new FakeRuntime())
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  test("requires authentication", async () => {
    expect((await get("/stats")).status).toBe(401)
    expect((await get("/stats", "wrong-key")).status).toBe(401)
  })

  test("the god key and an admin user get the host stats, 24h by default", async () => {
    for (const key of ["god-key", keys.admin!]) {
      const res = await get("/stats", key)
      expect(res.status).toBe(200)
      const data = ((await res.json()) as ApiResponse<HostStats>).data!
      expect(data.range).toBe("24h")
      expect(data.cores).toBeGreaterThan(0)
      expect(data.intervalSeconds).toBe(60)
      expect(Array.isArray(data.samples)).toBe(true)
      expect(data.current.memTotal).toBeGreaterThan(0)
      expect(data.current.diskTotal).toBeGreaterThan(0)
    }
  })

  test("returns the recorded history for the range", async () => {
    const now = Date.now()
    const line = (at: number) =>
      JSON.stringify({ at, cpu: 12.5, load1: 0.3, memUsed: 1, memTotal: 2, diskUsed: 3, diskTotal: 4 })
    writeFileSync(join(dataDir, "host-stats.jsonl"), [line(now - 3 * 3600_000), line(now - 60_000)].join("\n"))
    server = new AgentServer({
      apiKey: "god-key", dataDir, domain: "example.com",
      maxUploadSize: 1, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
    }, new FakeRuntime())
    const oneHour = ((await (await get("/stats?range=1h", "god-key")).json()) as ApiResponse<HostStats>).data!
    expect(oneHour.samples).toHaveLength(1)
    expect(oneHour.samples[0]!.cpu).toBe(12.5)
    const day = ((await (await get("/stats?range=24h", "god-key")).json()) as ApiResponse<HostStats>).data!
    expect(day.samples).toHaveLength(2)
  })

  test("rejects unknown ranges, including prototype keys", async () => {
    for (const range of ["30d", "1H", "", "__proto__", "constructor", "toString", "hasOwnProperty", "1h,7d"]) {
      const res = await get(`/stats?range=${encodeURIComponent(range)}`, "god-key")
      // An empty range falls back to the default.
      expect(res.status).toBe(range === "" ? 200 : 400)
    }
  })

  test("members, tenant keys and tenant owners never see the host", async () => {
    expect((await get("/stats", keys.mia!)).status).toBe(404)
    expect((await get("/stats", "key-friend", "api.friend.com")).status).toBe(404)
    expect((await get("/stats", keys.olga!, "api.friend.com")).status).toBe(404)
    // The god key is not valid on a tenant's API host.
    expect((await get("/stats", "god-key", "api.friend.com")).status).toBe(401)
  })

  test("only GET is served", async () => {
    const res = await server.handleRequestForTest(new Request("http://x/stats", { method: "POST", headers: { "X-API-Key": "god-key" } }))
    expect(res.status).not.toBe(200)
  })

  test("a host it cannot read answers 500, not a crash", async () => {
    rmSync(dataDir, { recursive: true, force: true })
    const res = await get("/stats", "god-key")
    expect(res.status).toBe(500)
  })
})
