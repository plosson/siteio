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

  test("GET /ui is self-contained: styles, icons and scripts inline, nothing from another host", async () => {
    const html = await (await fetch(`${baseUrl}/ui`)).text()
    expect(html).toContain("function siteioAdmin")
    expect(html).toContain("window.Alpine")
    expect(html).toContain("--brand: #007AFF")
    expect(html).toContain(".hgi-refresh {")
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i)
    expect(html).not.toMatch(/<link[^>]*rel="stylesheet"/i)
    for (const host of ["unpkg.com", "cdn.tailwindcss.com", "hugeicons.com", "fonts.googleapis.com", "fonts.gstatic.com"]) {
      expect(html).not.toContain(host)
    }
    // The placeholders were all filled.
    for (const mark of ["__ICON_URI__", "/*__STYLES__*/", "//__CHAT_CORE__", "//__UI_JS__", "//__ALPINE__"]) {
      expect(html).not.toContain(mark)
    }
  })

  test("every icon the page uses has a glyph", async () => {
    const html = await (await fetch(`${baseUrl}/ui`)).text()
    const used = new Set([...html.matchAll(/hgi-([a-z0-9-]+)/g)].map((m) => m[1]).filter((n) => n !== "stroke"))
    expect(used.size).toBeGreaterThan(10)
    for (const name of used) expect(html).toContain(`.hgi-${name} { --hgi: url(`)
  })

  test("the old separate asset paths are gone (404, no auth needed)", async () => {
    for (const path of ["/ui/ui.js", "/ui/ui.css", "/ui/chat-core.js"]) {
      const res = await fetch(`${baseUrl}${path}`)
      expect(res.status).toBe(404)
    }
  })

  test("matching If-None-Match yields a 304 with the same ETag", async () => {
    const first = await fetch(`${baseUrl}/ui`)
    const etag = first.headers.get("etag")!
    expect(etag).toBeTruthy()

    const revalidated = await fetch(`${baseUrl}/ui`, { headers: { "If-None-Match": etag } })
    expect(revalidated.status).toBe(304)
    expect(revalidated.headers.get("etag")).toBe(etag)
    expect(await revalidated.text()).toBe("")

    // A stale/mismatched validator, or a weak form of the same one, still gets the full body.
    for (const stale of ['"stale"', `W/${etag}`, etag.slice(1, -1)]) {
      const mismatch = await fetch(`${baseUrl}/ui`, { headers: { "If-None-Match": stale } })
      expect(mismatch.status).toBe(200)
      expect((await mismatch.text()).length).toBeGreaterThan(0)
    }
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

  test("the UI logs in with a password and sends X-Siteio-UI on cookie requests", async () => {
    const html = await (await fetch(`${baseUrl}/ui`)).text()
    expect(html).toContain("/auth/login")
    expect(html).toContain(`"X-Siteio-UI": "1"`)
    expect(html).toContain("Use API key")
    expect(html).toContain("route.view === 'users'")
    expect(html).toContain("route.view === 'account'")
    expect(html).toContain("Signed in with the server key")
    expect(html).toContain("Create user")
    expect(html).toContain("Signed-in devices")
    expect(html).toContain("data-1p-ignore")
    expect(html).toContain("Confirm new password")
    expect(html).toContain("navigator.clipboard")
    expect(html).toContain("sign in at")
  })
})
