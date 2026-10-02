import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AgentServer } from "../../lib/agent/server"
import { AppStorage } from "../../lib/agent/app-storage"
import { FakeRuntime } from "../helpers/fake-runtime"
import type { AgentConfig, ApiResponse, App, AppInfo } from "../../types"

const API_KEY = "auto-deploy-api-test-key"
const GIT = { repoUrl: "https://x.test/r.git", branch: "main" }

let dir: string
let server: AgentServer

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "siteio-auto-deploy-api-"))
  const config: AgentConfig = {
    apiKey: API_KEY,
    dataDir: dir,
    domain: "auto.test",
    maxUploadSize: 1024 * 1024,
    httpPort: 80,
    httpsPort: 443,
    skipTraefik: true,
  }
  server = new AgentServer(config, new FakeRuntime())
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

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

describe("create", () => {
  test("stores the mode", async () => {
    const res = await call<App>("POST", "/apps", { name: "web", git: { ...GIT, autoDeploy: "tag" }, internalPort: 3000 })
    expect(res.status).toBe(200)
    expect(res.body.data?.git?.autoDeploy).toBe("tag")
  })

  test("no mode stays unset (off)", async () => {
    const res = await call<App>("POST", "/apps", { name: "web", git: GIT })
    expect(res.body.data?.git?.autoDeploy).toBeUndefined()
  })

  test.each([["weekly"], [""], ["TAG"], [1], [null], [["tag"]]])("rejects %p", async (autoDeploy) => {
    const res = await call<App>("POST", "/apps", { name: "web", git: { ...GIT, autoDeploy } })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain("autoDeploy must be one of: off, commit, tag")
    expect(new AppStorage(dir).exists("web")).toBe(false)
  })

  test("rejects a git compose app", async () => {
    const res = await call<App>("POST", "/apps", {
      name: "stack",
      git: { ...GIT, autoDeploy: "commit" },
      composePath: "docker-compose.yml",
      primaryService: "web",
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain("single-container git apps")
  })
})

describe("update", () => {
  test("turns auto-deploy on for a git app without touching other git fields", async () => {
    await call("POST", "/apps", { name: "web", git: { ...GIT, dockerfile: "Dockerfile.prod" } })
    const res = await call<App>("PATCH", "/apps/web", { git: { autoDeploy: "commit" } })
    expect(res.status).toBe(200)
    expect(res.body.data?.git?.autoDeploy).toBe("commit")
    expect(res.body.data?.git?.dockerfile).toBe("Dockerfile.prod")
  })

  test("rejects an image app", async () => {
    await call("POST", "/apps", { name: "img", image: "nginx" })
    const res = await call<App>("PATCH", "/apps/img", { git: { autoDeploy: "tag" } })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain("single-container git apps")
    expect(new AppStorage(dir).get("img")?.git).toBeUndefined()
  })

  test("rejects an inline-Dockerfile app", async () => {
    await call("POST", "/apps", { name: "df", dockerfileContent: "FROM nginx\n" })
    const res = await call<App>("PATCH", "/apps/df", { git: { autoDeploy: "tag" } })
    expect(res.status).toBe(400)
  })

  test("rejects an unknown value", async () => {
    await call("POST", "/apps", { name: "web", git: GIT })
    const res = await call<App>("PATCH", "/apps/web", { git: { autoDeploy: "weekly" } })
    expect(res.status).toBe(400)
    expect(new AppStorage(dir).get("web")?.git?.autoDeploy).toBeUndefined()
  })

  test("changing the mode clears the poller state", async () => {
    await call("POST", "/apps", { name: "web", git: { ...GIT, autoDeploy: "tag" } })
    new AppStorage(dir).update("web", { autoDeployRef: "v1.0.0", autoDeployError: "deploy failed for v1.0.0: x" })
    const res = await call<App>("PATCH", "/apps/web", { git: { autoDeploy: "commit" } })
    expect(res.body.data?.autoDeployRef).toBeUndefined()
    expect(res.body.data?.autoDeployError).toBeUndefined()
  })

  test("setting the same mode keeps the poller state", async () => {
    await call("POST", "/apps", { name: "web", git: { ...GIT, autoDeploy: "tag" } })
    new AppStorage(dir).update("web", { autoDeployRef: "v1.0.0" })
    const res = await call<App>("PATCH", "/apps/web", { git: { autoDeploy: "tag" } })
    expect(res.body.data?.autoDeployRef).toBe("v1.0.0")
  })

  test("an unrelated update keeps the poller state", async () => {
    await call("POST", "/apps", { name: "web", git: { ...GIT, autoDeploy: "tag" } })
    new AppStorage(dir).update("web", { autoDeployRef: "v1.0.0" })
    const res = await call<App>("PATCH", "/apps/web", { internalPort: 8080 })
    expect(res.body.data?.autoDeployRef).toBe("v1.0.0")
  })

  test.each([
    ["repoUrl", { repoUrl: "https://x.test/other.git" }],
    ["branch", { branch: "release" }],
  ])("changing %s clears the poller state", async (_field, change) => {
    await call("POST", "/apps", { name: "web", git: { ...GIT, autoDeploy: "tag" } })
    new AppStorage(dir).update("web", { autoDeployRef: "v1.0.0", autoDeployError: "deploy failed for v1.0.0: x" })
    const res = await call<App>("PATCH", "/apps/web", { git: change })
    expect(res.status).toBe(200)
    expect(res.body.data?.autoDeployRef).toBeUndefined()
    expect(res.body.data?.autoDeployError).toBeUndefined()
    expect(new AppStorage(dir).get("web")?.autoDeployRef).toBeUndefined()
  })

  test("resending the same repoUrl and branch keeps the poller state", async () => {
    await call("POST", "/apps", { name: "web", git: { ...GIT, autoDeploy: "tag" } })
    new AppStorage(dir).update("web", { autoDeployRef: "v1.0.0" })
    const res = await call<App>("PATCH", "/apps/web", { git: { ...GIT } })
    expect(res.body.data?.autoDeployRef).toBe("v1.0.0")
  })

  test("server-owned fields are ignored", async () => {
    await call("POST", "/apps", { name: "web", git: { ...GIT, autoDeploy: "tag" } })
    new AppStorage(dir).update("web", { autoDeployRef: "v1.0.0" })
    await call<App>("PATCH", "/apps/web", {
      autoDeployRef: "v99.0.0",
      autoDeployCheckedAt: "2000-01-01T00:00:00.000Z",
      autoDeployError: "forged",
    })
    const stored = new AppStorage(dir).get("web")!
    expect(stored.autoDeployRef).toBe("v1.0.0")
    expect(stored.autoDeployCheckedAt).toBeUndefined()
    expect(stored.autoDeployError).toBeUndefined()
  })
})

describe("read", () => {
  test("the app list carries the poller state", async () => {
    await call("POST", "/apps", { name: "web", git: { ...GIT, autoDeploy: "tag" } })
    new AppStorage(dir).update("web", {
      autoDeployRef: "v1.0.0",
      autoDeployCheckedAt: "2026-10-02T10:00:00.000Z",
      autoDeployError: "check failed: x",
    })
    const res = await call<AppInfo[]>("GET", "/apps")
    const web = res.body.data!.find((a) => a.name === "web")!
    expect(web.git?.autoDeploy).toBe("tag")
    expect(web.autoDeployRef).toBe("v1.0.0")
    expect(web.autoDeployCheckedAt).toBe("2026-10-02T10:00:00.000Z")
    expect(web.autoDeployError).toBe("check failed: x")
  })
})
