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

  test("GET /ui returns HTML shell", async () => {
    const res = await fetch(`${baseUrl}/ui`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain("<html")
    expect(body).toContain("siteioAdmin()")
  })

  test("GET /ui/app.js returns JS", async () => {
    const res = await fetch(`${baseUrl}/ui/app.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/javascript")
    const body = await res.text()
    expect(body).toContain("function siteioAdmin")
  })

  test("GET /ui/app.css returns CSS", async () => {
    const res = await fetch(`${baseUrl}/ui/app.css`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/css")
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
