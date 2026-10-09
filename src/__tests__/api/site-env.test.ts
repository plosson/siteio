import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { SiteStorage } from "../../lib/agent/storage.ts"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, Tenant } from "../../types.ts"

const T: Tenant = { domain: "friend.com", apiKey: "key-t", createdAt: "2026-10-08T00:00:00.000Z" }
const SECRET = "sk_live_probe_value_123"

describe("Site env", () => {
  let dataDir: string
  let runtime: FakeRuntime
  let server: AgentServer

  const req = (path: string, init: RequestInit = {}, host = "localhost") =>
    server.handleRequestForTest(new Request(`http://x${path}`, init), host)
  const as = (key: string, extra: Record<string, string> = {}) => ({ "X-API-Key": key, ...extra })
  const zip = () => zipSync({ "public/index.html": new TextEncoder().encode("<h1>hi</h1>") })
  const deploy = (name: string, key = "god-key", host = "localhost") =>
    req(`/sites/${name}`, { method: "POST", headers: as(key, { "Content-Type": "application/zip" }), body: zip() }, host)
  const setEnv = (name: string, body: unknown, key = "god-key", host = "localhost") =>
    req(`/sites/${name}/env`, {
      method: "PATCH",
      headers: as(key, { "Content-Type": "application/json" }),
      body: typeof body === "string" ? body : JSON.stringify(body),
    }, host)
  const lastRunEnv = () => (runtime.callsOf("run").at(-1)!.args[0] as { env: Record<string, string> }).env

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-site-env-"))
    runtime = new FakeRuntime()
    const config: AgentConfig = {
      apiKey: "god-key", dataDir, domain: "example.com",
      maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true, tenants: [T],
    }
    server = new AgentServer(config, runtime)
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  describe("container", () => {
    test("a deploy passes the site env, and the agent's superuser vars win", async () => {
      await deploy("blog")
      new SiteStorage(dataDir).updateEnv("blog", { env: { A: "1" }, secrets: { S: SECRET } })
      await deploy("blog")
      const env = lastRunEnv()
      expect(env.A).toBe("1")
      expect(env.S).toBe(SECRET)
      expect(env.POCKET_SUPERUSER_EMAIL).toBe("admin@blog.example.com")
    })

    test("a hand-edited reserved key on the record still can't override the superuser vars", async () => {
      await deploy("blog")
      const storage = new SiteStorage(dataDir)
      storage.update("blog", { env: { POCKET_SUPERUSER_PASSWORD: "hijack" } }) // bypasses validation on purpose
      await deploy("blog")
      expect(lastRunEnv().POCKET_SUPERUSER_PASSWORD).toBe(storage.get("blog")!.superuserPassword)
    })

    test("rename, rollback and a domain change keep the env", async () => {
      await deploy("blog")
      await deploy("blog")
      new SiteStorage(dataDir).updateEnv("blog", { secrets: { S: SECRET } })
      runtime.containerExistsReturn = true

      await req("/sites/blog/domains", {
        method: "PATCH", headers: as("god-key", { "Content-Type": "application/json" }),
        body: JSON.stringify({ domains: ["www.blog.org"] }),
      })
      expect(lastRunEnv().S).toBe(SECRET)

      await req("/sites/blog/rollback", {
        method: "POST", headers: as("god-key", { "Content-Type": "application/json" }), body: JSON.stringify({ version: 1 }),
      })
      expect(lastRunEnv().S).toBe(SECRET)

      await req("/sites/blog/rename", {
        method: "PATCH", headers: as("god-key", { "Content-Type": "application/json" }),
        body: JSON.stringify({ newSubdomain: "journal" }),
      })
      expect(lastRunEnv().S).toBe(SECRET)
      expect(new SiteStorage(dataDir).get("journal")!.secretKeys).toEqual(["S"])
    })
  })
})
