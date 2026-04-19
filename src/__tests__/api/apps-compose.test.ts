import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { AgentServer } from "../../lib/agent/server"
import type { AgentConfig, App, AppInfo } from "../../types"
import { FakeRuntime } from "../helpers/fake-runtime"

const apiKey = "test-api-key"
const testPort = 4577

describe("API: Apps (compose)", () => {
  let testDir: string
  let server: AgentServer
  let runtime: FakeRuntime
  let baseUrl: string

  const inlineCompose = `services:
  web:
    image: nginx
  db:
    image: postgres:16
`

  beforeAll(async () => {
    testDir = mkdtempSync(join(tmpdir(), "siteio-apps-compose-test-"))
    runtime = new FakeRuntime()
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
    server = new AgentServer(config, runtime)
    await server.start()
    baseUrl = `http://localhost:${testPort}`
  })

  afterAll(async () => {
    server.stop()
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    runtime.calls = []
  })

  const req = async (method: string, path: string, body?: object) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "X-API-Key": apiKey,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })

  const jsonOk = async <T>(r: Response): Promise<T> => {
    expect(r.status).toBeLessThan(300)
    const parsed = (await r.json()) as { success: boolean; data: T; error?: string }
    expect(parsed.success).toBe(true)
    return parsed.data
  }

  describe("create", () => {
    test("inline compose: persists app with compose:{source:inline,primaryService}", async () => {
      const r = await req("POST", "/apps", {
        name: "composeapp",
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      })
      const app = await jsonOk<App>(r)
      expect(app.compose).toEqual({ source: "inline", primaryService: "web" })
      expect(app.image).toBe("siteio-composeapp:latest")
      expect(app.internalPort).toBe(80)

      // compose file persisted to dataDir/compose/<name>/docker-compose.yml
      expect(existsSync(join(testDir, "compose", "composeapp", "docker-compose.yml"))).toBe(true)
    })

    test("git+compose: persists compose:{source:git,path,primaryService} and GitSource", async () => {
      const r = await req("POST", "/apps", {
        name: "gitcomposeapp",
        git: { repoUrl: "https://example.test/repo.git", branch: "main" },
        composePath: "docker-compose.prod.yml",
        primaryService: "api",
        internalPort: 4000,
      })
      const app = await jsonOk<App>(r)
      expect(app.compose).toEqual({
        source: "git",
        path: "docker-compose.prod.yml",
        primaryService: "api",
      })
      expect(app.git?.repoUrl).toBe("https://example.test/repo.git")
    })

    test("rejects when compose + image both supplied", async () => {
      const r = await req("POST", "/apps", {
        name: "bad1",
        image: "nginx",
        composeContent: inlineCompose,
        primaryService: "web",
      })
      expect(r.status).toBe(400)
    })

    test("rejects when compose + inline dockerfile both supplied", async () => {
      const r = await req("POST", "/apps", {
        name: "bad2",
        dockerfileContent: "FROM nginx",
        composeContent: inlineCompose,
        primaryService: "web",
      })
      expect(r.status).toBe(400)
    })

    test("rejects composeContent without primaryService", async () => {
      const r = await req("POST", "/apps", {
        name: "bad3",
        composeContent: inlineCompose,
      })
      expect(r.status).toBe(400)
    })

    test("rejects composePath without git source", async () => {
      const r = await req("POST", "/apps", {
        name: "bad4",
        composePath: "docker-compose.yml",
        primaryService: "web",
      })
      expect(r.status).toBe(400)
    })

    test("rejects primaryService without any compose input", async () => {
      const r = await req("POST", "/apps", {
        name: "bad5",
        image: "nginx",
        primaryService: "web",
      })
      expect(r.status).toBe(400)
    })

    test("rejects when both composeContent and composePath are supplied", async () => {
      const r = await req("POST", "/apps", {
        name: "bad6",
        git: { repoUrl: "https://example.test/r.git", branch: "main" },
        composeContent: inlineCompose,
        composePath: "docker-compose.yml",
        primaryService: "web",
      })
      expect(r.status).toBe(400)
    })

    test("rejects git+composePath without primaryService", async () => {
      const r = await req("POST", "/apps", {
        name: "bad7",
        git: { repoUrl: "https://example.test/r.git", branch: "main" },
        composePath: "docker-compose.yml",
      })
      expect(r.status).toBe(400)
    })
  })

  describe("deploy", () => {
    test("inline compose: writes override, calls composeConfig then composeUp then composePs", async () => {
      await req("POST", "/apps", {
        name: "deployinline",
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      })
      const r = await req("POST", "/apps/deployinline/deploy")
      const app = await jsonOk<App>(r)

      // containerId resolved from composePs() primary-service match
      expect(app.containerId).toBe("fake-web-id")
      expect(app.status).toBe("running")

      // Override file written
      const overridePath = join(testDir, "compose", "deployinline", "docker-compose.siteio.yml")
      expect(existsSync(overridePath)).toBe(true)
      expect(readFileSync(overridePath, "utf-8")).toContain("siteio-network")

      // Runtime calls in order: composeConfig, composeUp, composePs
      const methods = runtime.calls.map((c) => c.method)
      const composeConfigIdx = methods.indexOf("composeConfig")
      const composeUpIdx = methods.indexOf("composeUp")
      const composePsIdx = methods.indexOf("composePs")
      expect(composeConfigIdx).toBeGreaterThan(-1)
      expect(composeUpIdx).toBeGreaterThan(composeConfigIdx)
      expect(composePsIdx).toBeGreaterThan(composeUpIdx)

      // Project name is siteio-<app>; files are [base, override]
      const upCall = runtime.calls[composeUpIdx]!
      expect(upCall.args[0]).toBe("siteio-deployinline")
      const files = upCall.args[1] as string[]
      expect(files).toHaveLength(2)
      expect(files[0]).toBe(join(testDir, "compose", "deployinline", "docker-compose.yml"))
      expect(files[1]).toBe(overridePath)
    })

    test("deploy fails with 400 if primary service not found in compose config", async () => {
      await req("POST", "/apps", {
        name: "badprimary",
        composeContent: inlineCompose,
        primaryService: "nonexistent",
        internalPort: 80,
      })
      runtime.composeConfigReturn = { services: { web: {}, db: {} } }
      const r = await req("POST", "/apps/badprimary/deploy")
      expect(r.status).toBe(400)

      // composeUp must NOT have been called
      expect(runtime.callsOf("composeUp")).toHaveLength(0)
    })

    test("redeploy after env update regenerates override and invokes composeUp", async () => {
      await req("POST", "/apps", {
        name: "envapp",
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      })
      // reset fixture mutated by prior test
      runtime.composeConfigReturn = { services: { web: {}, db: {} } }
      await req("POST", "/apps/envapp/deploy")

      // Update env via PATCH
      await req("PATCH", "/apps/envapp", { env: { FOO: "bar" } })
      runtime.calls = []

      await req("POST", "/apps/envapp/deploy")

      const overridePath = join(testDir, "compose", "envapp", "docker-compose.siteio.yml")
      expect(readFileSync(overridePath, "utf-8")).toContain('FOO: "bar"')
      expect(runtime.callsOf("composeUp")).toHaveLength(1)
    })
  })
})
