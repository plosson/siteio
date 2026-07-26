import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, ApiResponse, ShareGrantInfo, ShareGrantCreated } from "../../types.ts"

function makeServer(dataDir: string, runtime: FakeRuntime): AgentServer {
  const config: AgentConfig = {
    apiKey: "test-key", dataDir, domain: "example.com",
    maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
  }
  return new AgentServer(config, runtime)
}

const AUTH = { "X-API-Key": "test-key" }
const ZIPH = { ...AUTH, "Content-Type": "application/zip" }
const JSONH = { ...AUTH, "Content-Type": "application/json" }

describe("API: share grants", () => {
  let dataDir: string
  let runtime: FakeRuntime
  let server: AgentServer

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-grants-api-"))
    runtime = new FakeRuntime()
    server = makeServer(dataDir, runtime)
    // Deploy a site so grants have something to attach to.
    await server.handleRequestForTest(
      new Request("http://x/sites/blog", {
        method: "POST", headers: ZIPH,
        body: zipSync({ "public/index.html": new TextEncoder().encode("<h1>hi</h1>") }),
      })
    )
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  const createGrant = (body: Record<string, unknown> = {}, name = "blog") =>
    server.handleRequestForTest(
      new Request(`http://x/sites/${name}/grants`, { method: "POST", headers: JSONH, body: JSON.stringify(body) })
    )

  test("POST /sites/:name/grants returns a one-time token and the MCP url", async () => {
    const res = await createGrant({ deploys: 2 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiResponse<ShareGrantCreated>
    expect(body.data!.token).toStartWith("grt_")
    expect(body.data!.url).toBe(`https://blog.example.com/mcp/${body.data!.token}`)
    expect(body.data!.grant.site).toBe("blog")
    expect(body.data!.grant.active).toBe(true)
  })

  test("owner-set deploy budget and label are honored", async () => {
    const res = await createGrant({ maxDeploys: 5, label: "Sam" })
    const body = (await res.json()) as ApiResponse<ShareGrantCreated>
    expect(body.data!.grant.maxDeploys).toBe(5)
    expect(body.data!.grant.label).toBe("Sam")
  })

  test("GET /sites/:name/grants lists grants without leaking the token hash", async () => {
    await createGrant()
    await createGrant()
    const res = await server.handleRequestForTest(
      new Request("http://x/sites/blog/grants", { method: "GET", headers: AUTH })
    )
    const body = (await res.json()) as ApiResponse<ShareGrantInfo[]>
    expect(body.data).toHaveLength(2)
    expect((body.data![0] as unknown as Record<string, unknown>).tokenHash).toBeUndefined()
  })

  test("DELETE /sites/:name/grants/:id revokes the grant", async () => {
    const created = (await (await createGrant()).json()) as ApiResponse<ShareGrantCreated>
    const id = created.data!.grant.id
    const del = await server.handleRequestForTest(
      new Request(`http://x/sites/blog/grants/${id}`, { method: "DELETE", headers: AUTH })
    )
    expect(del.status).toBe(200)
    const list = (await (
      await server.handleRequestForTest(new Request("http://x/sites/blog/grants", { method: "GET", headers: AUTH }))
    ).json()) as ApiResponse<ShareGrantInfo[]>
    expect(list.data![0]!.active).toBe(false)
    expect(list.data![0]!.revoked).toBe(true)
  })

  test("cannot revoke a grant belonging to another site", async () => {
    await server.handleRequestForTest(
      new Request("http://x/sites/shop", {
        method: "POST", headers: ZIPH,
        body: zipSync({ "public/index.html": new TextEncoder().encode("<h1>shop</h1>") }),
      })
    )
    const created = (await (await createGrant({}, "blog")).json()) as ApiResponse<ShareGrantCreated>
    const res = await server.handleRequestForTest(
      new Request(`http://x/sites/shop/grants/${created.data!.grant.id}`, { method: "DELETE", headers: AUTH })
    )
    expect(res.status).toBe(404)
  })

  test("creating a grant for a missing site is 404", async () => {
    const res = await createGrant({}, "nope")
    expect(res.status).toBe(404)
  })

  test("grant routes require the god API key", async () => {
    const res = await server.handleRequestForTest(
      new Request("http://x/sites/blog/grants", { method: "GET" })
    )
    expect(res.status).toBe(401)
  })
})
