import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { AgentServer } from "../../lib/agent/server"
import type { AgentConfig, App, AppInfo, AppStatus } from "../../types"
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

  describe("lifecycle", () => {
    const setup = async (name: string) => {
      await req("POST", "/apps", {
        name,
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      })
      runtime.composeConfigReturn = { services: { web: {}, db: {} } }
      await req("POST", `/apps/${name}/deploy`)
      runtime.calls = []
    }

    test("stop invokes composeStop, not docker.stop", async () => {
      await setup("stopapp")
      const r = await req("POST", "/apps/stopapp/stop")
      const app = await jsonOk<App>(r)
      expect(app.status).toBe("stopped")
      expect(runtime.callsOf("composeStop")).toHaveLength(1)
      expect(runtime.callsOf("stop")).toHaveLength(0)
      expect(runtime.callsOf("composeStop")[0]!.args[0]).toBe("siteio-stopapp")
    })

    test("restart invokes composeRestart", async () => {
      await setup("restartapp")
      const r = await req("POST", "/apps/restartapp/restart")
      const app = await jsonOk<App>(r)
      expect(app.status).toBe("running")
      expect(runtime.callsOf("composeRestart")).toHaveLength(1)
      expect(runtime.callsOf("restart")).toHaveLength(0)
    })

    test("delete invokes composeDown and removes compose dir + metadata", async () => {
      await setup("delapp")
      const r = await req("DELETE", "/apps/delapp")
      expect(r.status).toBeLessThan(300)
      expect(runtime.callsOf("composeDown")).toHaveLength(1)
      expect(runtime.callsOf("composeDown")[0]!.args[0]).toBe("siteio-delapp")

      expect(existsSync(join(testDir, "compose", "delapp"))).toBe(false)
      const check = await req("GET", "/apps/delapp")
      expect(check.status).toBe(404)
    })
  })

  describe("logs", () => {
    const setup = async (name: string) => {
      await req("POST", "/apps", {
        name,
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      })
      runtime.composeConfigReturn = { services: { web: {}, db: {} } }
      await req("POST", `/apps/${name}/deploy`)
      runtime.calls = []
    }

    test("default tails the primary service", async () => {
      await setup("logs1")
      runtime.composeLogsReturn = "hello from web\n"
      const r = await req("GET", "/apps/logs1/logs")
      const body = (await r.json()) as { success: boolean; data: { logs: string } }
      expect(body.data.logs).toBe("hello from web\n")

      const call = runtime.callsOf("composeLogs")[0]!
      expect(call.args[3]).toEqual({ service: "web", tail: 100, all: false })
    })

    test("?service=db targets that service", async () => {
      await setup("logs2")
      const r = await req("GET", "/apps/logs2/logs?service=db")
      expect(r.status).toBeLessThan(300)
      const call = runtime.callsOf("composeLogs")[0]!
      expect(call.args[3]).toEqual({ service: "db", tail: 100, all: false })
    })

    test("?all=true omits service filter", async () => {
      await setup("logs3")
      const r = await req("GET", "/apps/logs3/logs?all=true")
      expect(r.status).toBeLessThan(300)
      const call = runtime.callsOf("composeLogs")[0]!
      const opts = call.args[3] as { service?: string; all?: boolean; tail: number }
      expect(opts.all).toBe(true)
      expect(opts.tail).toBe(100)
    })

    test("?service on non-compose app returns 400", async () => {
      await req("POST", "/apps", { name: "plain", image: "nginx", internalPort: 80 })
      const r = await req("GET", "/apps/plain/logs?service=web")
      expect(r.status).toBe(400)
      expect(runtime.callsOf("composeLogs")).toHaveLength(0)
    })
  })

  describe("env file", () => {
    const inlineEnvFile = "POSTGRES_PASSWORD=secret\nFOO=bar\n"

    test("create with envFileContent persists .env next to compose file", async () => {
      const r = await req("POST", "/apps", {
        name: "envfileapp",
        composeContent: inlineCompose,
        envFileContent: inlineEnvFile,
        primaryService: "web",
        internalPort: 80,
      })
      await jsonOk<App>(r)
      const envPath = join(testDir, "compose", "envfileapp", ".env")
      expect(existsSync(envPath)).toBe(true)
      expect(readFileSync(envPath, "utf-8")).toContain("POSTGRES_PASSWORD=secret")
    })

    test("create rejects envFileContent without compose", async () => {
      const r = await req("POST", "/apps", {
        name: "badenv",
        image: "nginx",
        envFileContent: inlineEnvFile,
      })
      expect(r.status).toBe(400)
    })

    const siteioEnv = (name: string) => join(testDir, "compose", name, "siteio.env")

    test("deploy passes siteio.env (siteio vars, then the user's .env) to every compose call", async () => {
      await req("POST", "/apps", {
        name: "deployenv",
        composeContent: inlineCompose,
        envFileContent: inlineEnvFile,
        primaryService: "web",
        internalPort: 80,
      })
      runtime.composeConfigReturn = { services: { web: {}, db: {} } }
      await jsonOk<App>(await req("POST", "/apps/deployenv/deploy"))

      for (const method of ["composeConfig", "composeUp", "composePs"]) {
        const calls = runtime.callsOf(method)
        expect(calls.length).toBeGreaterThan(0)
        expect(calls.at(-1)!.args[2]).toBe(siteioEnv("deployenv"))
      }
      const content = readFileSync(siteioEnv("deployenv"), "utf-8")
      expect(content).toContain("SITEIO_APP=deployenv\n")
      expect(content).toContain("SITEIO_DOMAIN=deployenv.test.example.com\n")
      expect(content).toContain("SITEIO_URL=https://deployenv.test.example.com\n")
      // User values come last so they win over siteio's
      expect(content.indexOf("POSTGRES_PASSWORD=secret")).toBeGreaterThan(content.indexOf("SITEIO_URL="))
      // The user's own file is left untouched
      expect(readFileSync(join(testDir, "compose", "deployenv", ".env"), "utf-8")).toBe(inlineEnvFile)
    })

    test("without a user .env, siteio.env still carries the siteio vars", async () => {
      await req("POST", "/apps", { name: "noenv", composeContent: inlineCompose, primaryService: "web", internalPort: 80 })
      runtime.composeConfigReturn = { services: { web: {}, db: {} } }
      await req("POST", "/apps/noenv/deploy")

      expect(runtime.callsOf("composeUp").at(-1)!.args[2]).toBe(siteioEnv("noenv"))
      expect(readFileSync(siteioEnv("noenv"), "utf-8")).toContain("SITEIO_URL=https://noenv.test.example.com")
    })

    test("a custom domain replaces the default one on the next compose call", async () => {
      await req("POST", "/apps", { name: "domenv", composeContent: inlineCompose, primaryService: "web", internalPort: 80 })
      await jsonOk<App>(await req("PATCH", "/apps/domenv", { domains: ["notes.acme.test"] }))
      await req("POST", "/apps/domenv/deploy")
      const content = readFileSync(siteioEnv("domenv"), "utf-8")
      expect(content).toContain("SITEIO_URL=https://notes.acme.test\n")
      expect(content).not.toContain("domenv.test.example.com")
    })

    test("the create-time check already resolves ${SITEIO_URL} with the requested domain", async () => {
      await jsonOk<App>(await req("POST", "/apps", {
        name: "createenv",
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
        domains: ["first.acme.test"],
      }))
      const call = runtime.callsOf("composeConfig").at(-1)!
      expect(call.args[2]).toBe(siteioEnv("createenv"))
      expect(readFileSync(siteioEnv("createenv"), "utf-8")).toContain("SITEIO_URL=https://first.acme.test")
    })

    test("git stacks keep the repo's .env next to the compose file", async () => {
      await jsonOk<App>(await req("POST", "/apps", {
        name: "gitenv",
        git: { repoUrl: "https://example.test/repo.git" },
        composePath: "deploy/docker-compose.yml",
        primaryService: "web",
        internalPort: 80,
      }))
      // Stand in for a clone: lifecycle calls never re-clone
      const repoDir = join(testDir, "repos", "gitenv", "deploy")
      mkdirSync(repoDir, { recursive: true })
      writeFileSync(join(repoDir, "docker-compose.yml"), inlineCompose)
      writeFileSync(join(repoDir, ".env"), "REPO_VAR=from-repo\n")

      await req("GET", "/apps/gitenv/logs")
      expect(runtime.callsOf("composeLogs").at(-1)!.args[2]).toBe(siteioEnv("gitenv"))
      expect(readFileSync(siteioEnv("gitenv"), "utf-8")).toContain("REPO_VAR=from-repo")
    })

    test("an uploaded .env wins over the repo's for git stacks", async () => {
      await jsonOk<App>(await req("PATCH", "/apps/gitenv", { envFileContent: "UPLOADED=1\n" }))
      await req("GET", "/apps/gitenv/logs")
      const content = readFileSync(siteioEnv("gitenv"), "utf-8")
      expect(content).toContain("UPLOADED=1")
      expect(content).not.toContain("REPO_VAR")
    })

    test("stop/restart/delete/logs thread siteio.env through", async () => {
      await req("POST", "/apps", {
        name: "lifecycleenv",
        composeContent: inlineCompose,
        envFileContent: inlineEnvFile,
        primaryService: "web",
        internalPort: 80,
      })
      runtime.composeConfigReturn = { services: { web: {}, db: {} } }
      await req("POST", "/apps/lifecycleenv/deploy")
      runtime.calls = []

      const expectedEnvPath = siteioEnv("lifecycleenv")

      await req("POST", "/apps/lifecycleenv/stop")
      expect(runtime.callsOf("composeStop")[0]!.args[2]).toBe(expectedEnvPath)

      await req("POST", "/apps/lifecycleenv/restart")
      expect(runtime.callsOf("composeRestart")[0]!.args[2]).toBe(expectedEnvPath)

      await req("GET", "/apps/lifecycleenv/logs")
      // composeLogs signature: (project, files, envFile, opts) → envFile at args[2]
      expect(runtime.callsOf("composeLogs")[0]!.args[2]).toBe(expectedEnvPath)

      await req("DELETE", "/apps/lifecycleenv")
      expect(runtime.callsOf("composeDown")[0]!.args[2]).toBe(expectedEnvPath)
    })
  })

  describe("warnings", () => {
    test("deploy warns when primary service publishes ports", async () => {
      await req("POST", "/apps", {
        name: "portsapp",
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      })
      runtime.composeConfigReturn = {
        services: {
          web: { ports: ["8080:80"] },
          db: {},
        },
      }
      const r = await req("POST", "/apps/portsapp/deploy")
      const parsed = (await r.json()) as { success: boolean; data: { warnings: string[] } }
      expect(parsed.data.warnings).toBeInstanceOf(Array)
      expect(parsed.data.warnings.some((w) => w.includes("publishes ports"))).toBe(true)
    })

    test("deploy warns when any service uses container_name", async () => {
      await req("POST", "/apps", {
        name: "cnameapp",
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      })
      runtime.composeConfigReturn = {
        services: {
          web: {},
          db: { container_name: "fixed-db-name" },
        },
      }
      const r = await req("POST", "/apps/cnameapp/deploy")
      const parsed = (await r.json()) as { success: boolean; data: { warnings: string[] } }
      expect(parsed.data.warnings.some((w) => w.includes("container_name"))).toBe(true)
      expect(parsed.data.warnings.some((w) => w.includes("fixed-db-name"))).toBe(true)
    })

    test("deploy with clean compose returns empty warnings array", async () => {
      await req("POST", "/apps", {
        name: "cleanapp",
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      })
      runtime.composeConfigReturn = {
        services: { web: {}, db: {} },
      }
      const r = await req("POST", "/apps/cleanapp/deploy")
      const parsed = (await r.json()) as { success: boolean; data: { warnings: string[] } }
      expect(parsed.data.warnings).toEqual([])
    })

    test("warnings include both when primary has ports AND another service has container_name", async () => {
      await req("POST", "/apps", {
        name: "bothapp",
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      })
      runtime.composeConfigReturn = {
        services: {
          web: { ports: ["3000:3000"] },
          db: { container_name: "metamcp-pg" },
        },
      }
      const r = await req("POST", "/apps/bothapp/deploy")
      const parsed = (await r.json()) as { success: boolean; data: { warnings: string[] } }
      expect(parsed.data.warnings.length).toBe(2)
    })
  })

  describe("list", () => {
    test("lists a compose app with compose field intact", async () => {
      await req("POST", "/apps", {
        name: "listapp",
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      })
      const r = await req("GET", "/apps")
      const parsed = (await r.json()) as { success: boolean; data: AppInfo[] }
      const entry = parsed.data.find((a) => a.name === "listapp")
      expect(entry).toBeTruthy()
      expect(entry!.compose).toEqual({ source: "inline", primaryService: "web" })
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

    test("app without a custom domain routes on the default subdomain", async () => {
      await req("POST", "/apps", {
        name: "nodomain",
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      })
      await jsonOk<App>(await req("POST", "/apps/nodomain/deploy"))

      const override = readFileSync(join(testDir, "compose", "nodomain", "docker-compose.siteio.yml"), "utf-8")
      expect(override).toContain('traefik.http.routers.siteio-nodomain.rule: "Host(`nodomain.test.example.com`)"')
    })

    test("custom domains replace the default subdomain on redeploy", async () => {
      await req("POST", "/apps", {
        name: "withdomain",
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      })
      await jsonOk<App>(await req("POST", "/apps/withdomain/deploy"))
      await jsonOk<App>(await req("PATCH", "/apps/withdomain", { domains: ["custom.other.test"] }))
      await jsonOk<App>(await req("POST", "/apps/withdomain/deploy"))

      const override = readFileSync(join(testDir, "compose", "withdomain", "docker-compose.siteio.yml"), "utf-8")
      expect(override).toContain('rule: "Host(`custom.other.test`)"')
      expect(override).not.toContain("withdomain.test.example.com")
    })

    test("primary service keeps the networks the base file put it on", async () => {
      await req("POST", "/apps", {
        name: "keepnet",
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      })
      // What `docker compose config` resolves for a service with no networks: key
      runtime.composeConfigReturn = { services: { web: { networks: { default: null } }, db: {} } }
      await jsonOk<App>(await req("POST", "/apps/keepnet/deploy"))

      const override = readFileSync(join(testDir, "compose", "keepnet", "docker-compose.siteio.yml"), "utf-8")
      expect(override).toMatch(/networks:\s+- "default"\s+- "siteio-network"/m)

      // Deploy resolves the base file alone, once; compose up does the merge
      runtime.calls = []
      await jsonOk<App>(await req("POST", "/apps/keepnet/deploy"))
      const configCalls = runtime.callsOf("composeConfig")
      expect(configCalls).toHaveLength(1)
      expect((configCalls[0]!.args[1] as string[])).toHaveLength(1)
    })

    test("a file compose rejects at deploy: 400 with its error, app marked failed, nothing started", async () => {
      runtime.composeConfigReturn = { services: { web: {}, db: {} } }
      await jsonOk<App>(await req("POST", "/apps", { name: "badatdeploy", composeContent: inlineCompose, primaryService: "web", internalPort: 80 }))
      runtime.composeConfigError = new Error("docker compose config failed: invalid interpolation format")
      try {
        const r = await req("POST", "/apps/badatdeploy/deploy")
        expect(r.status).toBe(400)
        expect(((await r.json()) as { error: string }).error).toContain("invalid interpolation")
        expect(runtime.callsOf("composeUp")).toHaveLength(0)
        const app = await jsonOk<App>(await req("GET", "/apps/badatdeploy"))
        expect(app.status).toBe("failed")
      } finally {
        runtime.composeConfigError = null
      }
    })

    test("primary service gone from the file at deploy: 400, no override, no compose up", async () => {
      // A git repo (or the file behind it) can change after create; deploy re-checks
      runtime.composeConfigReturn = { services: { web: {}, db: {} } }
      await jsonOk<App>(await req("POST", "/apps", {
        name: "nooverride",
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      }))
      runtime.composeConfigReturn = { services: { db: {} } }
      try {
        const r = await req("POST", "/apps/nooverride/deploy")
        expect(r.status).toBe(400)
        expect(((await r.json()) as { error: string }).error).toContain("Available: db")
        expect(existsSync(join(testDir, "compose", "nooverride", "docker-compose.siteio.yml"))).toBe(false)
        expect(runtime.callsOf("composeUp")).toHaveLength(0)
      } finally {
        runtime.composeConfigReturn = { services: { web: {}, db: {} } }
      }
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

  describe("update compose source", () => {
    const basePath = (name: string) => join(testDir, "compose", name, "docker-compose.yml")
    const envPath = (name: string) => join(testDir, "compose", name, ".env")
    const createInline = (name: string) =>
      req("POST", "/apps", { name, composeContent: inlineCompose, primaryService: "web", internalPort: 80 })
    const newCompose = "services:\n  web:\n    image: nginx\n    networks: [default]\n  cache:\n    image: redis\n"

    test("replaces the uploaded compose file in place, and deploy uses it", async () => {
      await createInline("upd1")
      const app = await jsonOk<App>(await req("PATCH", "/apps/upd1", { composeContent: newCompose }))
      expect(app.compose).toEqual({ source: "inline", primaryService: "web" })
      expect(readFileSync(basePath("upd1"), "utf-8")).toBe(newCompose)

      await jsonOk<App>(await req("POST", "/apps/upd1/deploy"))
      const up = runtime.callsOf("composeUp").at(-1)!
      expect((up.args[1] as string[])[0]).toBe(basePath("upd1"))
    })

    test("changes the primary service and keeps the source", async () => {
      await createInline("upd2")
      const app = await jsonOk<App>(await req("PATCH", "/apps/upd2", { primaryService: "db" }))
      expect(app.compose).toEqual({ source: "inline", primaryService: "db" })
    })

    test("writes a new .env for interpolation", async () => {
      await createInline("upd3")
      await jsonOk<App>(await req("PATCH", "/apps/upd3", { envFileContent: "TAG=1.2\n" }))
      expect(readFileSync(envPath("upd3"), "utf-8")).toBe("TAG=1.2\n")
    })

    test("git compose apps cannot take an uploaded file", async () => {
      await req("POST", "/apps", {
        name: "updgit",
        git: { repoUrl: "https://example.test/repo.git", branch: "main" },
        composePath: "docker-compose.yml",
        primaryService: "api",
        internalPort: 4000,
      })
      const r = await req("PATCH", "/apps/updgit", { composeContent: newCompose })
      expect(r.status).toBe(400)
      expect(((await r.json()) as { error: string }).error).toContain("git repository")
      expect(existsSync(basePath("updgit"))).toBe(false)
    })

    test("git compose apps can still change the primary service", async () => {
      const app = await jsonOk<App>(await req("PATCH", "/apps/updgit", { primaryService: "worker" }))
      expect(app.compose).toEqual({ source: "git", path: "docker-compose.yml", primaryService: "worker" })
    })

    test("non-compose apps reject every compose field", async () => {
      await req("POST", "/apps", { name: "updimg", image: "nginx", internalPort: 80 })
      for (const body of [{ composeContent: newCompose }, { envFileContent: "A=1" }, { primaryService: "web" }]) {
        const r = await req("PATCH", "/apps/updimg", body)
        expect(r.status).toBe(400)
      }
      const app = await jsonOk<App>(await req("GET", "/apps/updimg"))
      expect(app.compose).toBeUndefined()
      expect(existsSync(join(testDir, "compose", "updimg"))).toBe(false)
    })

    test("empty or whitespace-only values are rejected and nothing changes", async () => {
      await createInline("upd4")
      expect((await req("PATCH", "/apps/upd4", { composeContent: "  \n" })).status).toBe(400)
      expect((await req("PATCH", "/apps/upd4", { primaryService: " " })).status).toBe(400)
      expect(readFileSync(basePath("upd4"), "utf-8")).toBe(inlineCompose)
      const app = await jsonOk<App>(await req("GET", "/apps/upd4"))
      expect(app.compose?.primaryService).toBe("web")
    })

    test("a request rejected by another field does not replace the file", async () => {
      await createInline("upd5")
      await jsonOk<App>(await req("PATCH", "/apps/upd5", { secrets: { TOKEN: "s3cret" } }))
      // Plain env on a secret key is refused by the record update
      const r = await req("PATCH", "/apps/upd5", { composeContent: newCompose, env: { TOKEN: "plain" } })
      expect(r.status).toBe(400)
      expect(readFileSync(basePath("upd5"), "utf-8")).toBe(inlineCompose)
    })

    test("a client cannot smuggle a compose source change through the compose field", async () => {
      await createInline("upd6")
      const r = await req("PATCH", "/apps/upd6", { primaryService: "db", compose: { source: "git", path: "x.yml", primaryService: "evil" } })
      const app = await jsonOk<App>(r)
      expect(app.compose).toEqual({ source: "inline", primaryService: "db" })

      const alone = await jsonOk<App>(await req("PATCH", "/apps/upd6", { compose: { source: "git", path: "x.yml", primaryService: "evil" } }))
      expect(alone.compose).toEqual({ source: "inline", primaryService: "db" })
    })
  })

  describe("checks when the file is stored", () => {
    const basePath = (name: string) => join(testDir, "compose", name, "docker-compose.yml")
    const envPath = (name: string) => join(testDir, "compose", name, ".env")
    const create = (name: string, primaryService = "web") =>
      req("POST", "/apps", { name, composeContent: inlineCompose, primaryService, internalPort: 80 })
    const reset = () => {
      runtime.composeConfigReturn = { services: { web: {}, db: {} } }
      runtime.composeConfigError = null
      runtime.isAvailableReturn = true
    }

    test("create returns the warnings, including relative bind mounts", async () => {
      runtime.composeConfigReturn = {
        services: {
          web: { ports: ["3010:3010"], volumes: [{ type: "bind", source: join(testDir, "compose", "chk1", "data"), target: "/data" }] },
          db: { container_name: "pg" },
        },
      }
      try {
        const app = await jsonOk<App & { warnings: string[] }>(await create("chk1"))
        expect(app.warnings).toHaveLength(3)
        expect(app.warnings.join("\n")).toContain("relative path")
        // Resolved alone, as the stored file, with the app's project name
        const call = runtime.callsOf("composeConfig").at(-1)!
        expect(call.args[0]).toBe("siteio-chk1")
        expect(call.args[1]).toEqual([basePath("chk1")])
      } finally {
        reset()
      }
    })

    test("create rejects an unknown service and leaves nothing behind", async () => {
      const r = await create("chk2", "ghost")
      expect(r.status).toBe(400)
      expect(((await r.json()) as { error: string }).error).toContain("Primary service 'ghost' not found")
      expect(existsSync(join(testDir, "compose", "chk2"))).toBe(false)
      expect((await req("GET", "/apps/chk2")).status).toBe(404)
    })

    test("create rejects a file docker compose cannot parse, with its error", async () => {
      runtime.composeConfigError = new Error("docker compose config failed: services.web.image must be a string")
      try {
        const r = await create("chk3")
        expect(r.status).toBe(400)
        expect(((await r.json()) as { error: string }).error).toContain("must be a string")
        expect(existsSync(join(testDir, "compose", "chk3"))).toBe(false)
      } finally {
        reset()
      }
    })

    test("create still works when docker is unavailable (checked at deploy instead)", async () => {
      runtime.isAvailableReturn = false
      try {
        const app = await jsonOk<App & { warnings?: string[] }>(await create("chk4", "ghost"))
        expect(app.warnings).toEqual([])
      } finally {
        reset()
      }
    })

    test("git compose apps are not checked at create (the repo is not cloned yet)", async () => {
      const before = runtime.callsOf("composeConfig").length
      await jsonOk<App>(await req("POST", "/apps", {
        name: "chkgit",
        git: { repoUrl: "https://example.test/repo.git" },
        composePath: "docker-compose.yml",
        primaryService: "ghost",
        internalPort: 80,
      }))
      expect(runtime.callsOf("composeConfig").length).toBe(before)
    })

    test("set --compose-file: an invalid file is rejected and the previous one kept", async () => {
      await jsonOk<App>(await create("chk5"))
      runtime.composeConfigError = new Error("yaml: line 2: did not find expected key")
      try {
        const r = await req("PATCH", "/apps/chk5", { composeContent: "services:\n  web: [\n", envFileContent: "A=1\n" })
        expect(r.status).toBe(400)
        expect(readFileSync(basePath("chk5"), "utf-8")).toBe(inlineCompose)
        // No .env before the request: none after
        expect(existsSync(envPath("chk5"))).toBe(false)
      } finally {
        reset()
      }
    })

    test("set --service to a service the file lacks is rejected; the record is unchanged", async () => {
      await jsonOk<App>(await create("chk6"))
      const r = await req("PATCH", "/apps/chk6", { primaryService: "ghost" })
      expect(r.status).toBe(400)
      const app = await jsonOk<App>(await req("GET", "/apps/chk6"))
      expect(app.compose?.primaryService).toBe("web")
    })

    test("set --compose-file returns the new file's warnings", async () => {
      await jsonOk<App>(await create("chk7"))
      runtime.composeConfigReturn = { services: { web: {}, db: { ports: ["5432:5432"] } } }
      try {
        const app = await jsonOk<App & { warnings: string[] }>(await req("PATCH", "/apps/chk7", { composeContent: inlineCompose }))
        expect(app.warnings).toHaveLength(1)
        expect(app.warnings[0]).toContain("Service 'db' publishes ports")
      } finally {
        reset()
      }
    })

    test("plain settings changes do not run compose config or return warnings", async () => {
      await jsonOk<App>(await create("chk8"))
      const before = runtime.callsOf("composeConfig").length
      const app = await jsonOk<App & { warnings?: string[] }>(await req("PATCH", "/apps/chk8", { env: { A: "1" } }))
      expect(runtime.callsOf("composeConfig").length).toBe(before)
      expect(app.warnings).toBeUndefined()
    })
  })

  describe("status", () => {
    const createCompose = (name: string, primaryService = "web") =>
      req("POST", "/apps", { name, composeContent: inlineCompose, primaryService, internalPort: 80 })

    test("compose: reports every service with exit code and health, flags the primary", async () => {
      await createCompose("st1")
      await req("POST", "/apps/st1/deploy")
      runtime.composePsReturn = [
        { service: "web", containerId: "w", state: "restarting", exitCode: 1 },
        { service: "db", containerId: "d", state: "running", exitCode: 0, health: "unhealthy" },
        { service: "migrate", containerId: "m", state: "exited", exitCode: 0 },
      ]
      try {
        const status = await jsonOk<AppStatus>(await req("GET", "/apps/st1/status"))
        expect(status.services).toEqual([
          { service: "web", primary: true, state: "restarting", exitCode: 1 },
          { service: "db", primary: false, state: "running", exitCode: 0, health: "unhealthy" },
          { service: "migrate", primary: false, state: "exited", exitCode: 0 },
        ])
        // Lists stopped containers too, or crashed services would be invisible
        const psCall = runtime.callsOf("composePs").at(-1)!
        expect(psCall.args[0]).toBe("siteio-st1")
      } finally {
        runtime.composePsReturn = [{ service: "web", containerId: "fake-web-id", state: "running" }]
      }
    })

    test("compose: a primary service with no container is reported as missing", async () => {
      await createCompose("st2")
      await req("POST", "/apps/st2/deploy")
      runtime.composePsReturn = [{ service: "db", containerId: "d", state: "running" }]
      try {
        const status = await jsonOk<AppStatus>(await req("GET", "/apps/st2/status"))
        expect(status.services[0]).toEqual({ service: "web", primary: true, state: "missing" })
        expect(status.services).toHaveLength(2)
      } finally {
        runtime.composePsReturn = [{ service: "web", containerId: "fake-web-id", state: "running" }]
      }
    })

    test("container app: reports the inspected state and exit code", async () => {
      await req("POST", "/apps", { name: "st3", image: "nginx", internalPort: 80 })
      runtime.inspectReturn = {
        id: "c",
        name: "siteio-st3",
        state: { running: false, status: "exited", exitCode: 137 },
        image: "nginx",
        ports: {},
      }
      try {
        const status = await jsonOk<AppStatus>(await req("GET", "/apps/st3/status"))
        expect(status.services).toEqual([{ service: "st3", primary: true, state: "exited", exitCode: 137 }])
      } finally {
        runtime.inspectReturn = null
      }
    })

    test("container app never deployed: reported as missing, not as an error", async () => {
      await req("POST", "/apps", { name: "st4", image: "nginx", internalPort: 80 })
      const status = await jsonOk<AppStatus>(await req("GET", "/apps/st4/status"))
      expect(status.services).toEqual([{ service: "st4", primary: true, state: "missing" }])
    })

    test("unknown app returns 404", async () => {
      const r = await req("GET", "/apps/nope/status")
      expect(r.status).toBe(404)
    })

    test("requires the API key", async () => {
      const r = await fetch(`${baseUrl}/apps/st4/status`)
      expect(r.status).toBe(401)
    })
  })
})
