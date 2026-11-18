import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AgentServer } from "../../lib/agent/server"
import { AppStorage } from "../../lib/agent/app-storage"
import { FakeRuntime } from "../helpers/fake-runtime"
import { makeRepo, type TestRepo } from "../helpers/git-repo"
import type { AgentConfig, ApiResponse, App } from "../../types"

// Deploys of a compose stack from a git repo: the path that auto-deploy uses.

const API_KEY = "compose-auto-deploy-test-key"

let dir: string
let runtime: FakeRuntime
let server: AgentServer
let repo: TestRepo

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "siteio-compose-auto-deploy-"))
  repo = makeRepo(join(dir, "repo"))
  writeFileSync(join(repo.work, "docker-compose.yml"), "services:\n  web:\n    image: nginx\n")
  repo.commit("compose file")
  repo.push()
  runtime = new FakeRuntime()
  const config: AgentConfig = {
    apiKey: API_KEY,
    dataDir: join(dir, "data"),
    domain: "stack.test",
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

function storage(): AppStorage {
  return new AppStorage(join(dir, "data"))
}

async function createStack(): Promise<App> {
  const res = await call<App>("POST", "/apps", {
    name: "stack",
    git: { repoUrl: repo.url, branch: "main", autoDeploy: "tag" },
    composePath: "docker-compose.yml",
    primaryService: "web",
    internalPort: 80,
  })
  expect(res.status).toBe(200)
  return storage().get("stack")!
}

describe("compose deploy for auto-deploy", () => {
  test("deploys the given tag, not the branch head", async () => {
    const tagged = repo.commit("release")
    repo.tag("v1.0.0")
    repo.commit("after the release")
    repo.push()
    const app = await createStack()
    const { updated } = await server.deployComposeApp(app, { ref: "v1.0.0" })
    expect(updated.commitHash).toBe(tagged)
    expect(updated.status).toBe("running")
    expect(runtime.calls.map((c) => c.method)).toContain("composeUp")
  })

  test("without a ref, deploys the branch head", async () => {
    const head = repo.commit("head")
    repo.push()
    const app = await createStack()
    const { updated } = await server.deployComposeApp(app)
    expect(updated.commitHash).toBe(head)
  })

  test("a successful deploy clears autoDeployError", async () => {
    await createStack()
    storage().update("stack", { autoDeployError: "deploy failed for v1.0.0: x" })
    await server.deployComposeApp(storage().get("stack")!)
    expect(storage().get("stack")!.autoDeployError).toBeUndefined()
  })

  test("an unknown tag fails the deploy, marks the app failed and releases the lock", async () => {
    const app = await createStack()
    await expect(server.deployComposeApp(app, { ref: "v9.9.9" })).rejects.toThrow()
    expect(storage().get("stack")!.status).toBe("failed")
    expect(server.isDeploying("stack")).toBe(false)
  })

  test("a compose file that the tag does not have is a 400", async () => {
    // The tag points to a commit before the compose file existed.
    const app = await createStack()
    const initial = Bun.spawnSync({ cmd: ["git", "rev-list", "--max-parents=0", "HEAD"], cwd: repo.work }).stdout.toString().trim()
    expect(Bun.spawnSync({ cmd: ["git", "tag", "v0.1.0", initial], cwd: repo.work }).exitCode).toBe(0)
    repo.push()
    await expect(server.deployComposeApp(app, { ref: "v0.1.0" })).rejects.toThrow("Compose file not found")
  })
})

describe("compose deploy lock", () => {
  test("a manual deploy during a compose deploy gets 409", async () => {
    await createStack()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const original = runtime.composeUp.bind(runtime)
    runtime.composeUp = async (...args) => {
      await gate
      return original(...args)
    }
    const first = call<App>("POST", "/apps/stack/deploy")
    while (!server.isDeploying("stack")) await Bun.sleep(5)
    const second = await call<App>("POST", "/apps/stack/deploy")
    expect(second.status).toBe(409)
    expect(second.body.error).toContain("Deploy already in progress")
    release()
    expect((await first).status).toBe(200)
    expect(runtime.calls.filter((c) => c.method === "composeUp")).toHaveLength(1)
    expect(server.isDeploying("stack")).toBe(false)
  })

  test("the poller does not deploy a stack while a manual deploy runs", async () => {
    await createStack()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const original = runtime.composeUp.bind(runtime)
    runtime.composeUp = async (...args) => {
      await gate
      return original(...args)
    }
    const manual = call<App>("POST", "/apps/stack/deploy")
    while (!server.isDeploying("stack")) await Bun.sleep(5)
    await expect(server.deployComposeApp(storage().get("stack")!, { ref: "main" })).rejects.toThrow("Deploy already in progress")
    release()
    expect((await manual).status).toBe(200)
  })
})
