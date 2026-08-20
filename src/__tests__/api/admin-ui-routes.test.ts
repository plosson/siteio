import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AgentServer } from "../../lib/agent/server"
import type { AgentConfig } from "../../types"

describe("API: Admin UI routes", () => {
  let testDir: string
  let server: AgentServer
  let baseUrl: string
  const apiKey = "test-api-key"
  const testPort = 4701

  beforeAll(async () => {
    testDir = mkdtempSync(join(tmpdir(), "siteio-admin-ui-test-"))
    const config: AgentConfig = {
      domain: "test.example.com",
      apiKey,
      dataDir: testDir,
      port: testPort,
      skipTraefik: true,
      maxUploadSize: 50 * 1024 * 1024,
      httpPort: 80,
      httpsPort: 443,
    }
    server = new AgentServer(config)
    await server.start()
    baseUrl = `http://localhost:${testPort}`
  })

  afterAll(() => {
    server.stop()
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  test("GET /ui returns HTML shell with a revalidatable ETag", async () => {
    const res = await fetch(`${baseUrl}/ui`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(res.headers.get("cache-control")).toBe("no-cache")
    expect(res.headers.get("etag")).toBeTruthy()
    const body = await res.text()
    expect(body).toContain("<html")
    expect(body).toContain("siteioAdmin()")
  })

  test("GET /ui/ui.js returns JS with an ETag and no-cache", async () => {
    const res = await fetch(`${baseUrl}/ui/ui.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/javascript")
    expect(res.headers.get("cache-control")).toBe("no-cache")
    expect(res.headers.get("etag")).toBeTruthy()
    const body = await res.text()
    expect(body).toContain("function siteioAdmin")
  })

  test("GET /ui/ui.css returns CSS with an ETag and no-cache", async () => {
    const res = await fetch(`${baseUrl}/ui/ui.css`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/css")
    expect(res.headers.get("cache-control")).toBe("no-cache")
    expect(res.headers.get("etag")).toBeTruthy()
  })

  test("matching If-None-Match yields a 304 with the same ETag", async () => {
    const first = await fetch(`${baseUrl}/ui/ui.js`)
    const etag = first.headers.get("etag")!
    expect(etag).toBeTruthy()

    const revalidated = await fetch(`${baseUrl}/ui/ui.js`, { headers: { "If-None-Match": etag } })
    expect(revalidated.status).toBe(304)
    expect(revalidated.headers.get("etag")).toBe(etag)
    expect(await revalidated.text()).toBe("")

    // A stale/mismatched validator still gets the full body.
    const mismatch = await fetch(`${baseUrl}/ui/ui.js`, { headers: { "If-None-Match": '"stale"' } })
    expect(mismatch.status).toBe(200)
    expect((await mismatch.text()).length).toBeGreaterThan(0)
  })

  test("unknown /ui/* path falls through to handleRequest 404", async () => {
    const res = await fetch(`${baseUrl}/ui/nonexistent`)
    expect(res.status).toBe(404)
  })

  test("existing /health endpoint still works (no regression)", async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { status: string } }
    expect(body.success).toBe(true)
    expect(body.data.status).toBe("ok")
  })

  test("existing /sites endpoint still rejects unauth (no regression)", async () => {
    const res = await fetch(`${baseUrl}/sites`)
    expect(res.status).toBe(401)
  })

  test("existing /sites endpoint still authenticates (no regression)", async () => {
    const res = await fetch(`${baseUrl}/sites`, { headers: { "X-API-Key": apiKey } })
    expect(res.status).toBe(200)
  })
})
