// src/__tests__/api/pockets.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import { POCKETBASE_IMAGE } from "../../lib/pocketbase-version.ts"
import type { AgentConfig, ApiResponse, PocketInfo } from "../../types.ts"

function makeServer(dataDir: string, runtime: FakeRuntime): AgentServer {
  const config: AgentConfig = {
    apiKey: "test-key", dataDir, domain: "example.com",
    maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
  }
  return new AgentServer(config, runtime)
}

const H = { "X-API-Key": "test-key", "Content-Type": "application/zip" }

describe("API: pockets", () => {
  let dataDir: string
  let runtime: FakeRuntime
  let server: AgentServer

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-pockets-"))
    runtime = new FakeRuntime()
    server = makeServer(dataDir, runtime)
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  const zip = () => zipSync({ "public/index.html": new TextEncoder().encode("<h1>hi</h1>") })

  test("POST /pockets/:name deploys a new pocket using the pinned image", async () => {
    const res = await server.handleRequestForTest(
      new Request("http://x/pockets/blog", { method: "POST", headers: H, body: zip() })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiResponse<PocketInfo>
    expect(body.success).toBe(true)
    expect(body.data!.url).toBe("https://blog.example.com")
    expect(body.data!.status).toBe("running")

    const runCall = runtime.calls.find((c) => c.method === "run")
    expect(runCall).toBeDefined()
    const pullCall = runtime.calls.find((c) => c.method === "pull")
    expect(pullCall!.args[0]).toBe(POCKETBASE_IMAGE)
  })

  test("GET /pockets lists deployed pockets", async () => {
    await server.handleRequestForTest(new Request("http://x/pockets/blog", { method: "POST", headers: H, body: zip() }))
    const res = await server.handleRequestForTest(new Request("http://x/pockets", { method: "GET", headers: { "X-API-Key": "test-key" } }))
    const body = (await res.json()) as ApiResponse<PocketInfo[]>
    expect(body.data).toHaveLength(1)
    expect(body.data?.[0]?.name).toBe("blog")
  })

  test("GET /pockets/:name/admin returns generated superuser credentials", async () => {
    await server.handleRequestForTest(new Request("http://x/pockets/blog", { method: "POST", headers: H, body: zip() }))
    const res = await server.handleRequestForTest(new Request("http://x/pockets/blog/admin", { method: "GET", headers: { "X-API-Key": "test-key" } }))
    const body = (await res.json()) as ApiResponse<{ email: string; password: string; adminUrl: string }>
    expect(body.data!.email).toContain("@")
    expect(body.data!.password.length).toBeGreaterThan(8)
    expect(body.data!.adminUrl).toBe("https://blog.example.com/_/")
  })

  test("POST /pockets/:name returns 500 and creates nothing when Docker is unavailable", async () => {
    runtime.isAvailableReturn = false
    const res = await server.handleRequestForTest(
      new Request("http://x/pockets/blog", { method: "POST", headers: H, body: zip() })
    )
    expect(res.status).toBe(500)
    const list = await server.handleRequestForTest(new Request("http://x/pockets", { method: "GET", headers: { "X-API-Key": "test-key" } }))
    const body = (await list.json()) as ApiResponse<PocketInfo[]>
    expect(body.data).toHaveLength(0)
  })

  test("DELETE /pockets/:name removes it", async () => {
    await server.handleRequestForTest(new Request("http://x/pockets/blog", { method: "POST", headers: H, body: zip() }))
    const del = await server.handleRequestForTest(new Request("http://x/pockets/blog", { method: "DELETE", headers: { "X-API-Key": "test-key" } }))
    expect(del.status).toBe(200)
    const list = await server.handleRequestForTest(new Request("http://x/pockets", { method: "GET", headers: { "X-API-Key": "test-key" } }))
    const body = (await list.json()) as ApiResponse<PocketInfo[]>
    expect(body.data).toHaveLength(0)
  })
})
