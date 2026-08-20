import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AgentServer } from "../../lib/agent/server"
import type { AgentConfig } from "../../types"

// Verifies the agent-level `appsEnabled` switch: when off, the whole /apps/*
// surface is unavailable (403); sites are unaffected. When the flag is unset
// (older configs / tests), apps stay enabled — the backward-compat default.

const apiKey = "test-api-key"

function makeConfig(dataDir: string, port: number, appsEnabled?: boolean): AgentConfig {
  return {
    domain: "test.example.com",
    apiKey,
    dataDir,
    port,
    skipTraefik: true,
    maxUploadSize: 50 * 1024 * 1024,
    httpPort: 80,
    httpsPort: 443,
    appsEnabled,
  }
}

describe("API: Apps disabled (agent-level)", () => {
  let testDir: string
  let server: AgentServer
  let baseUrl: string
  const testPort = 4599

  beforeAll(async () => {
    testDir = mkdtempSync(join(tmpdir(), "siteio-apps-disabled-test-"))
    server = new AgentServer(makeConfig(testDir, testPort, false))
    await server.start()
    baseUrl = `http://localhost:${testPort}`
  })

  afterAll(async () => {
    server.stop()
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  const request = (method: string, path: string, body?: object) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "X-API-Key": apiKey,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })

  test("every /apps/* route returns 403 when apps are disabled", async () => {
    const routes: [string, string][] = [
      ["GET", "/apps"],
      ["POST", "/apps"],
      ["GET", "/apps/foo"],
      ["PATCH", "/apps/foo"],
      ["DELETE", "/apps/foo"],
      ["POST", "/apps/foo/deploy"],
      ["POST", "/apps/foo/stop"],
      ["POST", "/apps/foo/restart"],
      ["GET", "/apps/foo/logs"],
    ]
    for (const [method, path] of routes) {
      const res = await request(method, path, method === "POST" ? {} : undefined)
      expect(res.status).toBe(403)
    }
  })

  test("unauthenticated apps request is still rejected as 401 (auth runs first)", async () => {
    const res = await fetch(`${baseUrl}/apps`, { method: "GET" })
    expect(res.status).toBe(401)
  })

  test("sites surface is unaffected when apps are disabled", async () => {
    const res = await request("GET", "/sites")
    expect(res.status).toBe(200)
  })
})

describe("API: Apps enabled by default when flag unset", () => {
  let testDir: string
  let server: AgentServer
  let baseUrl: string
  const testPort = 4600

  beforeAll(async () => {
    testDir = mkdtempSync(join(tmpdir(), "siteio-apps-default-test-"))
    // appsEnabled omitted entirely — must behave as enabled.
    server = new AgentServer(makeConfig(testDir, testPort, undefined))
    await server.start()
    baseUrl = `http://localhost:${testPort}`
  })

  afterAll(async () => {
    server.stop()
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  test("GET /apps works (200) when appsEnabled is unset", async () => {
    const res = await fetch(`${baseUrl}/apps`, {
      method: "GET",
      headers: { "X-API-Key": apiKey },
    })
    expect(res.status).toBe(200)
  })
})
