import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { SiteStorage } from "../../lib/agent/storage.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, ApiResponse, SiteInfo } from "../../types.ts"

const GOD = { "X-API-Key": "test-key" }
const GOD_ZIP = { ...GOD, "Content-Type": "application/zip" }
const GOD_JSON = { ...GOD, "Content-Type": "application/json" }

describe("API: site stop / start", () => {
  let dataDir: string
  let runtime: FakeRuntime
  let server: AgentServer

  const req = (path: string, init: RequestInit = {}, host = "localhost") =>
    server.handleRequestForTest(new Request(`http://x${path}`, init), host)
  const deploy = (name = "blog") =>
    req(`/sites/${name}`, { method: "POST", headers: GOD_ZIP, body: zipSync({ "public/index.html": new TextEncoder().encode("<h1>hi</h1>") }) })
  const stop = (name = "blog") => req(`/sites/${name}/stop`, { method: "POST", headers: GOD })
  const start = (name = "blog") => req(`/sites/${name}/start`, { method: "POST", headers: GOD })
  const stored = (name = "blog") => new SiteStorage(join(dataDir, "data")).get(name)!

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-site-stop-"))
    runtime = new FakeRuntime()
    server = new AgentServer(
      { apiKey: "test-key", dataDir: join(dataDir, "data"), domain: "example.com", maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true } as AgentConfig,
      runtime
    )
    expect((await deploy()).status).toBe(200)
    runtime.containerExistsReturn = true
    runtime.calls = []
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  test("stop removes the container and keeps the site, its code and its version", async () => {
    const before = stored()
    const res = await stop()
    expect(res.status).toBe(200)
    expect(((await res.json()) as ApiResponse<SiteInfo>).data!.status).toBe("stopped")
    expect(runtime.callsOf("remove").map((c) => c.args[0])).toEqual(["blog"])
    expect(runtime.callsOf("stop")).toHaveLength(0) // removed, not stopped: no restart policy can revive it
    expect(stored().status).toBe("stopped")
    expect(stored().version).toBe(before.version)
  })

  test("stopping twice is refused and changes nothing", async () => {
    await stop()
    runtime.calls = []
    const res = await stop()
    expect(res.status).toBe(409)
    expect(runtime.callsOf("remove")).toHaveLength(0)
    expect(stored().status).toBe("stopped")
  })

  test("start on a running site is refused and does not recreate it", async () => {
    const res = await start()
    expect(res.status).toBe(409)
    expect(runtime.callsOf("run")).toHaveLength(0)
  })

  test("start recreates the container with domains and env changed while stopped", async () => {
    await stop()
    runtime.containerExistsReturn = false
    const dom = await req("/sites/blog/domains", { method: "PATCH", headers: GOD_JSON, body: JSON.stringify({ domains: ["blog.acme.test"] }) })
    expect(dom.status).toBe(200)
    const env = await req("/sites/blog/env", { method: "PATCH", headers: GOD_JSON, body: JSON.stringify({ env: { PLAN: "pro" } }) })
    expect(env.status).toBe(200)
    expect(runtime.callsOf("run")).toHaveLength(0) // config changes leave it offline
    expect(stored().status).toBe("stopped")

    const res = await start()
    expect(res.status).toBe(200)
    expect(stored().status).toBe("running")
    const run = runtime.callsOf("run").at(-1)!.args[0] as { env: Record<string, string>; labels: Record<string, string> }
    expect(run.env.PLAN).toBe("pro")
    expect(JSON.stringify(run.labels)).toContain("blog.acme.test")
  })

  test("rename while stopped keeps it offline and stopped", async () => {
    await stop()
    runtime.containerExistsReturn = false
    const res = await req("/sites/blog/rename", { method: "PATCH", headers: GOD_JSON, body: JSON.stringify({ newSubdomain: "journal" }) })
    expect(res.status).toBe(200)
    expect(runtime.callsOf("run")).toHaveLength(0)
    expect(stored("journal").status).toBe("stopped")
  })

  test("a failed start marks the site failed and reports the error", async () => {
    await stop()
    runtime.runError = new Error("port in use")
    const res = await start()
    expect(res.status).toBe(500)
    expect(stored().status).toBe("failed")
  })

  test("the agent's own routes on a stopped site's host answer 404", async () => {
    expect((await req("/_siteio/health", {}, "blog.example.com")).status).toBe(200)
    await stop()
    for (const path of ["/_siteio/health", "/_siteio/edit", "/mcp", "/.well-known/oauth-protected-resource"]) {
      expect((await req(path, {}, "blog.example.com")).status).toBe(404)
    }
  })

  test("unknown site: stop and start answer 404", async () => {
    expect((await stop("nope")).status).toBe(404)
    expect((await start("nope")).status).toBe(404)
  })
})
