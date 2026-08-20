import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, ApiResponse } from "../../types.ts"

function makeServer(dataDir: string, runtime: FakeRuntime): AgentServer {
  const config: AgentConfig = {
    apiKey: "test-key", dataDir, domain: "example.com",
    maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443,
    email: "ops@example.com", skipTraefik: true,
  }
  return new AgentServer(config, runtime)
}

describe("API: GET /agent", () => {
  let dataDir: string
  let server: AgentServer

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-agent-info-"))
    server = makeServer(dataDir, new FakeRuntime())
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  test("requires authentication", async () => {
    const res = await server.handleRequestForTest(new Request("http://x/agent"))
    expect(res.status).toBe(401)
  })

  test("returns sanitized settings without secrets", async () => {
    const res = await server.handleRequestForTest(
      new Request("http://x/agent", { headers: { "X-API-Key": "test-key" } })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiResponse<Record<string, unknown>>
    expect(body.success).toBe(true)
    const data = body.data!
    expect(data.domain).toBe("example.com")
    expect(data.email).toBe("ops@example.com")
    expect(data.httpPort).toBe(8080)
    expect(data.httpsPort).toBe(8443)
    expect(data.appsEnabled).toBe(true)
    expect(typeof data.version).toBe("string")
    expect(data.siteCount).toBe(0)
    expect(data.appCount).toBe(0)
    // Secrets must never be exposed.
    expect(data.apiKey).toBeUndefined()
    expect(JSON.stringify(data)).not.toContain("test-key")
  })

  test("reflects appsEnabled=false", async () => {
    const config: AgentConfig = {
      apiKey: "test-key", dataDir, domain: "example.com",
      maxUploadSize: 1, httpPort: 80, httpsPort: 443, appsEnabled: false, skipTraefik: true,
    }
    const s = new AgentServer(config, new FakeRuntime())
    const res = await s.handleRequestForTest(
      new Request("http://x/agent", { headers: { "X-API-Key": "test-key" } })
    )
    const body = (await res.json()) as ApiResponse<Record<string, unknown>>
    expect(body.data!.appsEnabled).toBe(false)
  })
})
