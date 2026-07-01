import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, AgentOAuthConfig } from "../../types.ts"
import type { ContainerRunConfig } from "../../lib/agent/docker.ts"

function makeServer(dataDir: string, runtime: FakeRuntime): AgentServer {
  const config: AgentConfig = {
    apiKey: "test-key", dataDir, domain: "example.com",
    maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
  }
  return new AgentServer(config, runtime)
}

function writeAgentGoogle(dataDir: string, over: Partial<AgentOAuthConfig> = {}) {
  const cfg: AgentOAuthConfig = {
    issuerUrl: "https://accounts.google.com",
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

describe("API: pocket reuses the agent Google OAuth config", () => {
  let dataDir: string
  let runtime: FakeRuntime

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-greuse-"))
    runtime = new FakeRuntime()
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  const deploy = (server: AgentServer) =>
    server.handleRequestForTest(new Request("http://x/pockets/blog", { method: "POST", headers: H, body: zip() }))

  test("deploy without flags reuses the agent's Google client when issuer is Google", async () => {
    writeAgentGoogle(dataDir)
    const server = makeServer(dataDir, runtime)
    await deploy(server)
    const env = runEnv(runtime)
    expect(env.POCKET_GOOGLE_CLIENT_ID).toBe("agent-client-id")
    expect(env.POCKET_GOOGLE_CLIENT_SECRET).toBe("agent-client-secret")
  })

  test("no Google env when the agent has no OAuth config", async () => {
    const server = makeServer(dataDir, runtime)
    await deploy(server)
    const env = runEnv(runtime)
    expect(env.POCKET_GOOGLE_CLIENT_ID).toBeUndefined()
  })

  test("does not reuse a non-Google (generic OIDC) agent issuer", async () => {
    writeAgentGoogle(dataDir, { issuerUrl: "https://login.microsoftonline.com/common/v2.0" })
    const server = makeServer(dataDir, runtime)
    await deploy(server)
    const env = runEnv(runtime)
    expect(env.POCKET_GOOGLE_CLIENT_ID).toBeUndefined()
  })

  test("per-pocket flags override the agent config", async () => {
    writeAgentGoogle(dataDir)
    const server = makeServer(dataDir, runtime)
    await server.handleRequestForTest(new Request("http://x/pockets/blog", {
      method: "POST",
      headers: { ...H, "X-Pocket-Google-Client-Id": "flag-id", "X-Pocket-Google-Client-Secret": "flag-secret" },
      body: zip(),
    }))
    const env = runEnv(runtime)
    expect(env.POCKET_GOOGLE_CLIENT_ID).toBe("flag-id")
  })
})
