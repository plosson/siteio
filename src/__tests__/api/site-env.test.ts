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

  describe("PATCH /sites/:name/env", () => {
    type Out = { success: boolean; data?: { env?: Record<string, string>; secretKeys?: string[] }; error?: string }
    const body = async (res: Response) => (await res.json()) as Out

    test("stores env and secrets, returns keys but never secret values", async () => {
      await deploy("blog")
      const res = await setEnv("blog", { env: { A: "1" }, secrets: { S: SECRET } })
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).not.toContain(SECRET)
      const out = JSON.parse(text) as Out
      expect(out.data!.env).toEqual({ A: "1" })
      expect(out.data!.secretKeys).toEqual(["S"])
    })

    test("a running site is recreated with the new env at once", async () => {
      await deploy("blog")
      runtime.containerExistsReturn = true
      const runs = runtime.callsOf("run").length
      await setEnv("blog", { secrets: { S: SECRET } })
      expect(runtime.callsOf("run").length).toBe(runs + 1)
      expect(lastRunEnv().S).toBe(SECRET)
    })

    test("a site with no container only stores it; the first deploy uses it", async () => {
      await deploy("blog")
      runtime.containerExistsReturn = false
      const runs = runtime.callsOf("run").length
      expect((await setEnv("blog", { env: { A: "1" } })).status).toBe(200)
      expect(runtime.callsOf("run").length).toBe(runs)
      await deploy("blog")
      expect(lastRunEnv().A).toBe("1")
    })

    test("a secret value never appears in any site response", async () => {
      await deploy("blog")
      await setEnv("blog", { secrets: { S: SECRET } })
      const responses = [
        await req("/sites/blog", { headers: as("god-key") }),
        await req("/sites", { headers: as("god-key") }),
        await deploy("blog"),
        await req("/sites/blog/history", { headers: as("god-key") }),
        await setEnv("blog", { env: { S: "plain-attempt" } }), // refused
      ]
      for (const res of responses) expect(await res.text()).not.toContain(SECRET)
    })

    test("GET /sites lists no env at all", async () => {
      await deploy("blog")
      await setEnv("blog", { env: { A: "1" } })
      const list = await (await req("/sites", { headers: as("god-key") })).text()
      expect(list).not.toContain("secretKeys")
      expect(list).not.toContain('"env"')
    })

    test("refuses malformed bodies and stores nothing", async () => {
      await deploy("blog")
      for (const b of [
        "not json", "null", "[]", { env: "A=1" }, { env: { A: 1 } }, { env: { A: null } }, { secrets: ["S"] },
        { unsetEnv: "S" }, { unsetEnv: [1] }, { secretKeys: ["A"] },
      ]) {
        const res = await setEnv("blog", b)
        expect(res.status).toBe(400)
      }
      expect(new SiteStorage(dataDir).get("blog")!.env).toBeUndefined()
    })

    test("refuses invalid and reserved keys", async () => {
      await deploy("blog")
      for (const b of [{ env: { "A-B": "1" } }, { secrets: { POCKET_SUPERUSER_PASSWORD: "x" } }, { unsetEnv: ["POCKET_X"] }]) {
        expect((await setEnv("blog", b)).status).toBe(400)
      }
    })

    test("refuses to un-secret a key", async () => {
      await deploy("blog")
      await setEnv("blog", { secrets: { S: SECRET } })
      const res = await setEnv("blog", { env: { S: "x" } })
      expect(res.status).toBe(400)
      expect((await body(res)).error).toContain("'sites unset -e S'")
    })

    test("unknown site is 404", async () => {
      expect((await setEnv("ghost", { env: { A: "1" } })).status).toBe(404)
    })

    test("GET /sites/:name shows public env and secret keys", async () => {
      await deploy("blog")
      await setEnv("blog", { env: { A: "1" }, secrets: { S: SECRET } })
      const out = await body(await req("/sites/blog", { headers: as("god-key") }))
      expect(out.data!.env).toEqual({ A: "1" })
      expect(out.data!.secretKeys).toEqual(["S"])
    })

    test("a tenant manages its own site's env, never another scope's", async () => {
      await deploy("blog", "key-t", "api.friend.com")
      await deploy("shop")
      expect((await setEnv("blog", { secrets: { S: SECRET } }, "key-t", "api.friend.com")).status).toBe(200)
      expect((await setEnv("shop", { env: { A: "1" } }, "key-t", "api.friend.com")).status).toBe(404)
      expect((await setEnv("blog--friend-com", { env: { A: "1" } }, "key-t", "api.friend.com")).status).toBe(404)
      expect(new SiteStorage(dataDir).get("shop")!.env).toBeUndefined()
    })

    test("a share code can't read or set env", async () => {
      await deploy("blog")
      await setEnv("blog", { secrets: { S: SECRET } })
      const minted = await req("/sites/blog/grants", {
        method: "POST", headers: as("god-key", { "Content-Type": "application/json" }), body: JSON.stringify({}),
      })
      const { code } = ((await minted.json()) as { data: { code: string } }).data
      expect((await setEnv("blog", { env: { A: "1" } }, code)).status).toBe(403)
      const asGrant = await req("/sites/blog", { headers: as(code) })
      expect(await asGrant.text()).not.toContain('"secretKeys"')
    })
  })
})
