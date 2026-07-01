import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, AgentOAuthConfig } from "../../types.ts"
import type { ContainerRunConfig } from "../../lib/agent/docker.ts"

// A local OIDC discovery endpoint so the deploy handler's discovery is hermetic.
let discovery: ReturnType<typeof Bun.serve>
let issuer: string

beforeAll(() => {
  discovery = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url)
      const base = `http://127.0.0.1:${discovery.port}`
      if (u.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer: base + "/",
          authorization_endpoint: base + "/authorize",
          token_endpoint: base + "/oauth/token",
          userinfo_endpoint: base + "/userinfo",
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  issuer = `http://127.0.0.1:${discovery.port}/`
})
afterAll(() => discovery.stop(true))

function makeServer(dataDir: string, runtime: FakeRuntime): AgentServer {
  const config: AgentConfig = {
    apiKey: "test-key", dataDir, domain: "example.com",
    maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
  }
  return new AgentServer(config, runtime)
}

function writeAgentOIDC(dataDir: string, over: Partial<AgentOAuthConfig> = {}) {
  const cfg: AgentOAuthConfig = {
    issuerUrl: issuer,
    clientId: "agent-client-id",
    clientSecret: "agent-client-secret",
    cookieSecret: "x".repeat(32),
    cookieDomain: "example.com",
    ...over,
  }
  writeFileSync(join(dataDir, "oauth-config.json"), JSON.stringify(cfg))
}

const H = { "X-API-Key": "test-key", "Content-Type": "application/zip" }
const zip = () => zipSync({ "public/index.html": new TextEncoder().encode("x") })
const runEnv = (runtime: FakeRuntime) => {
  const call = runtime.calls.find((c) => c.method === "run")
  return (call?.args[0] as ContainerRunConfig | undefined)?.env ?? {}
}

describe("API: pocket reuses the agent OIDC config (any issuer)", () => {
  let dataDir: string
  let runtime: FakeRuntime

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-oidc-"))
    runtime = new FakeRuntime()
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  const deploy = (server: AgentServer, headers: Record<string, string> = {}) =>
    server.handleRequestForTest(new Request("http://x/pockets/blog", { method: "POST", headers: { ...H, ...headers }, body: zip() }))

  test("reuses the agent's OIDC client (non-Google issuer) and discovers endpoints", async () => {
    writeAgentOIDC(dataDir)
    const server = makeServer(dataDir, runtime)
    await deploy(server)

    const env = runEnv(runtime)
    expect(env.POCKET_OIDC_CLIENT_ID).toBe("agent-client-id")
    expect(env.POCKET_OIDC_CLIENT_SECRET).toBe("agent-client-secret")

    // The hook was written with the discovered endpoints.
    const hook = readFileSync(join(dataDir, "pocket-code", "blog", "pb_hooks", "_siteio_oauth.pb.js"), "utf-8")
    expect(hook).toContain(`${issuer.replace(/\/$/, "")}/oauth/token`)
    // And the client helper is present.
    expect(existsSync(join(dataDir, "pocket-code", "blog", "public", "pocket-oauth.js"))).toBe(true)
  })

  test("no OIDC env when the agent has no OAuth config", async () => {
    const server = makeServer(dataDir, runtime)
    await deploy(server)
    expect(runEnv(runtime).POCKET_OIDC_CLIENT_ID).toBeUndefined()
  })

  test("per-pocket OIDC flags override the agent config", async () => {
    writeAgentOIDC(dataDir)
    const server = makeServer(dataDir, runtime)
    await deploy(server, {
      "X-Pocket-OIDC-Issuer": issuer,
      "X-Pocket-OIDC-Client-Id": "flag-id",
      "X-Pocket-OIDC-Client-Secret": "flag-secret",
    })
    expect(runEnv(runtime).POCKET_OIDC_CLIENT_ID).toBe("flag-id")
  })

  test("discovery failure is non-fatal — pocket still deploys without login", async () => {
    writeAgentOIDC(dataDir, { issuerUrl: "http://127.0.0.1:1/" }) // nothing listening
    const server = makeServer(dataDir, runtime)
    const res = await deploy(server)
    expect(res.status).toBe(200)
    expect(runEnv(runtime).POCKET_OIDC_CLIENT_ID).toBeUndefined()
  })
})
