import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AgentServer } from "../../lib/agent/server"
import { AppStorage } from "../../lib/agent/app-storage"
import { FakeRuntime } from "../helpers/fake-runtime"
import { makeRepo, type TestRepo } from "../helpers/git-repo"
import type { AgentConfig, ApiResponse, App } from "../../types"

const API_KEY = "deploy-swap-test-key"

let dir: string
let runtime: FakeRuntime
let server: AgentServer
let repo: TestRepo

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "siteio-deploy-swap-"))
  repo = makeRepo(join(dir, "repo"))
  runtime = new FakeRuntime()
  runtime.containerExistsReturn = true // an old container is running
  const config: AgentConfig = {
    apiKey: API_KEY,
    dataDir: join(dir, "data"),
    domain: "swap.test",
    maxUploadSize: 1024 * 1024,
    httpPort: 80,
    httpsPort: 443,
    skipTraefik: true,
  }
  server = new AgentServer(config, runtime)
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

function methods(): string[] {
  return runtime.calls.map((c) => c.method)
}

async function createGitApp(extra: object = {}): Promise<void> {
  const res = await call("POST", "/apps", { name: "web", git: { repoUrl: repo.url, branch: "main" }, internalPort: 3000, ...extra })
  expect(res.status).toBe(200)
}

function storage(): AppStorage {
  return new AppStorage(join(dir, "data"))
}

describe("build before swap", () => {
  test("a successful deploy builds first, then removes and runs", async () => {
    await createGitApp()
    const res = await call<App>("POST", "/apps/web/deploy")
    expect(res.status).toBe(200)
    const m = methods()
    expect(m.indexOf("build")).toBeLessThan(m.indexOf("remove"))
    expect(m.indexOf("remove")).toBeLessThan(m.indexOf("run"))
  })

  test("a build failure leaves the old container alone and the status unchanged", async () => {
    await createGitApp()
    storage().update("web", { status: "running", containerId: "old-id" })
    runtime.buildError = new Error("docker build failed: step 3")
    const res = await call<App>("POST", "/apps/web/deploy")
    expect(res.status).toBe(500)
    expect(res.body.error).toContain("step 3")
    expect(methods()).not.toContain("remove")
    expect(methods()).not.toContain("run")
    const app = storage().get("web")!
    expect(app.status).toBe("running")
    expect(app.containerId).toBe("old-id")
  })

  test("a missing Dockerfile is a 400 and the old container keeps running", async () => {
    await createGitApp({ git: { repoUrl: repo.url, branch: "main", dockerfile: "nope/Dockerfile" } })
    const res = await call<App>("POST", "/apps/web/deploy")
    expect(res.status).toBe(400)
    expect(res.body.error).toContain("Dockerfile not found")
    expect(methods()).not.toContain("remove")
  })

  test("a context or Dockerfile outside the repository is refused, whoever set it", async () => {
    // apps/web.json exists in the data dir, two levels above repos/web
    for (const git of [{ context: "../.." }, { context: "src/../../.." }, { dockerfile: "../../apps/web.json" }]) {
      await createGitApp({ git: { repoUrl: repo.url, branch: "main", ...git } })
      const res = await call<App>("POST", "/apps/web/deploy")
      expect(res.status).toBe(400)
      expect(res.body.error).toContain("outside the repository")
      await call("DELETE", "/apps/web")
    }
    expect(methods()).not.toContain("build")
    expect(methods()).not.toContain("run")
  })

  test("a missing branch is reported and the old container keeps running", async () => {
    await createGitApp({ git: { repoUrl: repo.url, branch: "does-not-exist" } })
    const res = await call<App>("POST", "/apps/web/deploy")
    expect(res.status).toBe(500)
    expect(res.body.error).toContain("does-not-exist")
    expect(methods()).not.toContain("remove")
  })

  test("a failure after the swap marks the app failed", async () => {
    await createGitApp()
    runtime.run = async () => {
      throw new Error("container exited")
    }
    const res = await call<App>("POST", "/apps/web/deploy")
    expect(res.status).toBe(500)
    expect(storage().get("web")!.status).toBe("failed")
  })

  test("an image app pulls before it removes the old container", async () => {
    await call("POST", "/apps", { name: "img", image: "nginx", internalPort: 80 })
    runtime.pull = async () => {
      throw new Error("pull access denied")
    }
    const res = await call<App>("POST", "/apps/img/deploy")
    expect(res.status).toBe(500)
    expect(methods()).not.toContain("remove")
  })

  test("a successful deploy clears autoDeployError", async () => {
    await createGitApp()
    storage().update("web", { autoDeployError: "deploy failed for v1.0.0: x" })
    await call<App>("POST", "/apps/web/deploy")
    expect(storage().get("web")!.autoDeployError).toBeUndefined()
  })

  test("deployContainerApp builds the given tag, not the branch head", async () => {
    const tagged = repo.commit("release")
    repo.tag("v1.0.0")
    repo.commit("after")
    repo.push()
    await createGitApp()
    const app = await server.deployContainerApp("web", { ref: "v1.0.0" })
    expect(app.commitHash).toBe(tagged)
  })

  test("an unknown app is a 404", async () => {
    const res = await call<App>("POST", "/apps/ghost/deploy")
    expect(res.status).toBe(404)
  })
})

describe("deploy lock", () => {
  test("a second deploy during a build gets 409 and changes nothing", async () => {
    await createGitApp()
    let release!: () => void
    runtime.buildGate = new Promise<void>((r) => (release = r))

    const first = call<App>("POST", "/apps/web/deploy")
    while (!server.isDeploying("web")) await Bun.sleep(5)

    const second = await call<App>("POST", "/apps/web/deploy")
    expect(second.status).toBe(409)
    expect(second.body.error).toContain("Deploy already in progress")

    release()
    expect((await first).status).toBe(200)
    expect(methods().filter((m) => m === "build")).toHaveLength(1)
    expect(server.isDeploying("web")).toBe(false)
  })

  test("the lock is released after a failure", async () => {
    await createGitApp()
    runtime.buildError = new Error("boom")
    await call<App>("POST", "/apps/web/deploy")
    expect(server.isDeploying("web")).toBe(false)
    runtime.buildError = null
    expect((await call<App>("POST", "/apps/web/deploy")).status).toBe(200)
  })

  test("locks are per app", async () => {
    await createGitApp()
    await call("POST", "/apps", { name: "img", image: "nginx", internalPort: 80 })
    let release!: () => void
    runtime.buildGate = new Promise<void>((r) => (release = r))
    const first = call<App>("POST", "/apps/web/deploy")
    while (!server.isDeploying("web")) await Bun.sleep(5)
    expect((await call<App>("POST", "/apps/img/deploy")).status).toBe(200)
    release()
    await first
  })
})

describe("deploy lock against stop, restart and delete", () => {
  async function holdBuild(): Promise<{ deploy: Promise<{ status: number }>; release: () => void }> {
    await createGitApp()
    storage().update("web", { status: "running", containerId: "old-id" })
    let release!: () => void
    runtime.buildGate = new Promise<void>((r) => (release = r))
    const deploy = call<App>("POST", "/apps/web/deploy")
    while (!server.isDeploying("web")) await Bun.sleep(5)
    return { deploy, release }
  }

  test.each([
    ["stop", "POST", "/apps/web/stop"],
    ["restart", "POST", "/apps/web/restart"],
    ["delete", "DELETE", "/apps/web"],
  ])("%s during a build gets 409 and the deploy then completes", async (_label, method, path) => {
    const { deploy, release } = await holdBuild()
    const res = await call(method, path)
    expect(res.status).toBe(409)
    expect(res.body.error).toContain("Deploy already in progress")
    expect(methods()).not.toContain("stop")
    expect(methods()).not.toContain("restart")
    expect(methods()).not.toContain("remove")
    expect(storage().get("web")).not.toBeNull()

    release()
    expect((await deploy).status).toBe(200)
    const app = storage().get("web")!
    expect(app.status).toBe("running")
    expect(app.containerId).toBe(runtime.runReturn)
  })

  test("an app removed during the build is not swapped in", async () => {
    const { deploy, release } = await holdBuild()
    storage().delete("web")
    release()
    const res = await deploy
    expect(res.status).toBe(404)
    expect(methods()).not.toContain("remove")
    expect(methods()).not.toContain("run")
    expect(storage().get("web")).toBeNull()
  })
})

describe("status after a failed deploy", () => {
  test("a failure before the swap with no container marks the app failed", async () => {
    await createGitApp()
    runtime.containerExistsReturn = false
    runtime.buildError = new Error("boom")
    const res = await call<App>("POST", "/apps/web/deploy")
    expect(res.status).toBe(500)
    expect(storage().get("web")!.status).toBe("failed")
  })

  test("a failure before the swap with a container keeps the status", async () => {
    await createGitApp()
    storage().update("web", { status: "stopped" })
    runtime.buildError = new Error("boom")
    await call<App>("POST", "/apps/web/deploy")
    expect(storage().get("web")!.status).toBe("stopped")
  })

  test("a 404 for an app removed mid-build does not recreate it", async () => {
    await createGitApp()
    runtime.containerExistsReturn = false
    let release!: () => void
    runtime.buildGate = new Promise<void>((r) => (release = r))
    const deploy = call<App>("POST", "/apps/web/deploy")
    while (!server.isDeploying("web")) await Bun.sleep(5)
    storage().delete("web")
    release()
    expect((await deploy).status).toBe(404)
    expect(storage().get("web")).toBeNull()
  })
})
