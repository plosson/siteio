import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { AgentServer } from "../../lib/agent/server"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import type { AgentConfig, ApiResponse, App, AppInfo } from "../../types"

describe("Apps API - Secret env vars", () => {
  let server: AgentServer
  let tempDir: string
  let baseUrl: string
  const apiKey = "secrets-apps-test-key"
  const testPort = 4601

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "siteio-secrets-apps-test-"))

    const config: AgentConfig = {
      apiKey,
      dataDir: tempDir,
      domain: "secrets-test.local",
      maxUploadSize: 10 * 1024 * 1024,
      httpPort: 80,
      httpsPort: 443,
      port: testPort,
      skipTraefik: true,
    }

    server = new AgentServer(config)
    await server.start()
    baseUrl = `http://localhost:${testPort}`
  })

  afterAll(async () => {
    server.stop()
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  async function request<T>(method: string, path: string, body?: object): Promise<ApiResponse<T>> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "X-API-Key": apiKey,
        ...(body && { "Content-Type": "application/json" }),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    return response.json() as Promise<ApiResponse<T>>
  }

  const storedApp = (name: string) =>
    readFileSync(join(tempDir, "apps", `${name}.json`), "utf-8")

  test("create stores a secret encrypted and never echoes the value", async () => {
    const create = await request<App>("POST", "/apps", {
      name: "secret-app",
      image: "nginx:alpine",
      internalPort: 80,
      env: { NODE_ENV: "production" },
      secrets: { VAULT_PASSPHRASE: "not-a-secret-probe-value" },
    })

    expect(create.success).toBe(true)
    expect(create.data?.env).toEqual({ NODE_ENV: "production" })
    expect(create.data?.secrets).toBeUndefined()
    expect(create.data?.secretKeys).toEqual(["VAULT_PASSPHRASE"])
    expect(storedApp("secret-app")).not.toContain("not-a-secret-probe-value")
  })

  test("GET never returns secret values", async () => {
    const got = await request<App>("GET", "/apps/secret-app")
    expect(got.data?.secrets).toBeUndefined()
    expect(got.data?.secretKeys).toEqual(["VAULT_PASSPHRASE"])
    expect(JSON.stringify(got)).not.toContain("not-a-secret-probe-value")
  })

  test("LIST never returns secret values", async () => {
    const list = await request<AppInfo[]>("GET", "/apps")
    expect(JSON.stringify(list)).not.toContain("not-a-secret-probe-value")
  })

  test("PATCH adds a secret and reports only its key", async () => {
    const patch = await request<App>("PATCH", "/apps/secret-app", {
      secrets: { DATABASE_URL: "postgres://user:pw@db/app" },
    })

    expect(patch.success).toBe(true)
    expect(patch.data?.secrets).toBeUndefined()
    expect(patch.data?.secretKeys?.sort()).toEqual(["DATABASE_URL", "VAULT_PASSPHRASE"])
    expect(storedApp("secret-app")).not.toContain("postgres://user:pw@db/app")
  })

  test("PATCH refuses to turn a secret back into a plain env var", async () => {
    const patch = await request<App>("PATCH", "/apps/secret-app", {
      env: { VAULT_PASSPHRASE: "oops" },
    })

    expect(patch.success).toBe(false)
    expect(patch.error).toContain("is a secret")
    expect(storedApp("secret-app")).not.toContain("oops")
  })

  test("PATCH promotes an existing plain env var to a secret", async () => {
    await request<App>("PATCH", "/apps/secret-app", { env: { API_KEY: "was-plaintext" } })
    const patch = await request<App>("PATCH", "/apps/secret-app", { secrets: { API_KEY: "now-secret" } })

    expect(patch.data?.env?.API_KEY).toBeUndefined()
    expect(patch.data?.secretKeys).toContain("API_KEY")
    expect(storedApp("secret-app")).not.toContain("was-plaintext")
  })

  test("unsetEnv removes a secret", async () => {
    const patch = await request<App>("PATCH", "/apps/secret-app", { unsetEnv: ["API_KEY"] })

    expect(patch.success).toBe(true)
    expect(patch.data?.secretKeys).not.toContain("API_KEY")
  })

  test("clients cannot inject secretKeys into storage", async () => {
    await request<App>("PATCH", "/apps/secret-app", { secretKeys: ["INJECTED"] })
    const got = await request<App>("GET", "/apps/secret-app")

    expect(got.data?.secretKeys).not.toContain("INJECTED")
    expect(storedApp("secret-app")).not.toContain("INJECTED")
  })
})
