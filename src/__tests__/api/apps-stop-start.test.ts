import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AgentServer } from "../../lib/agent/server"
import { AppStorage } from "../../lib/agent/app-storage"
import { FakeRuntime } from "../helpers/fake-runtime"
import type { AgentConfig, ApiResponse, App } from "../../types"

const API_KEY = "stop-start-test-key"
let dir: string
let runtime: FakeRuntime
let server: AgentServer

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "siteio-stop-start-"))
  runtime = new FakeRuntime()
  const config: AgentConfig = {
    apiKey: API_KEY, dataDir: join(dir, "data"), domain: "stop.test",
    maxUploadSize: 1024 * 1024, httpPort: 80, httpsPort: 443, skipTraefik: true,
  }
  server = new AgentServer(config, runtime)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function call<T>(method: string, path: string, body?: object): Promise<{ status: number; body: ApiResponse<T> }> {
  const res = await server.handleRequestForTest(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "X-API-Key": API_KEY, ...(body && { "Content-Type": "application/json" }) },
      body: body ? JSON.stringify(body) : undefined,
    })
  )
  return { status: res.status, body: (await res.json()) as ApiResponse<T> }
}
const stored = () => new AppStorage(join(dir, "data")).get("web")!

async function deployedImageApp(): Promise<void> {
  expect((await call("POST", "/apps", { name: "web", image: "nginx:alpine", internalPort: 80 })).status).toBe(200)
  expect((await call("POST", "/apps/web/deploy")).status).toBe(200)
  runtime.containerExistsReturn = true
  runtime.imageExistsReturn = true
  runtime.calls = []
}

describe("apps stop", () => {
  test("removes the container instead of stopping it", async () => {
    await deployedImageApp()
    const res = await call<App>("POST", "/apps/web/stop")
    expect(res.status).toBe(200)
    expect(res.body.data!.status).toBe("stopped")
    expect(runtime.callsOf("remove").map((c) => c.args[0])).toEqual(["web"])
    expect(runtime.callsOf("stop")).toHaveLength(0)
  })

  test("stopping twice is refused", async () => {
    await deployedImageApp()
    await call("POST", "/apps/web/stop")
    runtime.calls = []
    expect((await call("POST", "/apps/web/stop")).status).toBe(409)
    expect(runtime.callsOf("remove")).toHaveLength(0)
  })
})

describe("apps start", () => {
  test("recreates the container from the image on the server, with no pull or build", async () => {
    await deployedImageApp()
    await call("POST", "/apps/web/stop")
    runtime.containerExistsReturn = false
    await call("PATCH", "/apps/web", { env: { PLAN: "pro" } })
    expect(runtime.callsOf("run")).toHaveLength(0) // a config change leaves it offline
    runtime.calls = []

    const res = await call<App>("POST", "/apps/web/start")
    expect(res.status).toBe(200)
    expect(stored().status).toBe("running")
    expect(runtime.callsOf("pull")).toHaveLength(0)
    expect(runtime.callsOf("build")).toHaveLength(0)
    const run = runtime.callsOf("run")[0]!.args[0] as { image: string; env: Record<string, string> }
    expect(run.image).toBe("nginx:alpine")
    expect(run.env.PLAN).toBe("pro")
  })

  test("with the image gone, start falls back to a full deploy instead of leaving the app stuck", async () => {
    await deployedImageApp()
    await call("POST", "/apps/web/stop")
    runtime.imageExistsReturn = false
    const res = await call<App>("POST", "/apps/web/start")
    expect(res.status).toBe(200)
    expect(runtime.callsOf("pull")).toHaveLength(1)
    expect(stored().status).toBe("running")
  })

  test("start on a running app is refused", async () => {
    await deployedImageApp()
    expect((await call("POST", "/apps/web/start")).status).toBe(409)
    expect(runtime.callsOf("run")).toHaveLength(0)
  })

  test("a failed start marks the app failed", async () => {
    await deployedImageApp()
    await call("POST", "/apps/web/stop")
    runtime.runError = new Error("port in use")
    expect((await call("POST", "/apps/web/start")).status).toBe(500)
    expect(stored().status).toBe("failed")
  })
})

describe("while stopped", () => {
  test("deploy is refused and the app stays stopped", async () => {
    await deployedImageApp()
    await call("POST", "/apps/web/stop")
    runtime.calls = []
    const res = await call("POST", "/apps/web/deploy")
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("App 'web' is stopped; run 'siteio apps start web' first")
    expect(runtime.callsOf("pull")).toHaveLength(0)
    expect(stored().status).toBe("stopped")
  })

  test("restart starts it, like start", async () => {
    await deployedImageApp()
    await call("POST", "/apps/web/stop")
    runtime.containerExistsReturn = false
    runtime.calls = []
    const res = await call<App>("POST", "/apps/web/restart")
    expect(res.status).toBe(200)
    expect(stored().status).toBe("running")
    expect(runtime.callsOf("restart")).toHaveLength(0) // there is no container to restart
    expect(runtime.callsOf("run")).toHaveLength(1)
  })
})
