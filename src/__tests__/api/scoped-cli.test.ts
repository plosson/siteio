import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync, unzipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, ApiResponse, ShareGrantCreated, SiteInfo, SiteVersion } from "../../types.ts"

function makeServer(dataDir: string, runtime: FakeRuntime): AgentServer {
  const config: AgentConfig = {
    apiKey: "god-key", dataDir, domain: "example.com",
    maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
  }
  return new AgentServer(config, runtime)
}

const GOD = { "X-API-Key": "god-key" }
const GOD_ZIP = { ...GOD, "Content-Type": "application/zip" }
const GOD_JSON = { ...GOD, "Content-Type": "application/json" }

describe("API: scoped share-code CLI credential", () => {
  let dataDir: string
  let runtime: FakeRuntime
  let server: AgentServer

  const zip = (files: Record<string, string>) =>
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)])))

  const deploy = (name: string, files: Record<string, string>, headers = GOD_ZIP) =>
    server.handleRequestForTest(new Request(`http://x/sites/${name}`, { method: "POST", headers, body: zip(files) }))

  const mintCode = async (name: string, body: Record<string, unknown> = {}): Promise<string> => {
    const res = await server.handleRequestForTest(
      new Request(`http://x/sites/${name}/grants`, { method: "POST", headers: GOD_JSON, body: JSON.stringify(body) })
    )
    return ((await res.json()) as ApiResponse<ShareGrantCreated>).data!.code
  }

  // The scoped CLI reaches the agent under the SITE host via the /_siteio
  // channel (what the standard CLI does once logged in with the scoped token).
  const SITE_HOST = "blog.example.com"
  const sReq = (path: string, init: RequestInit, host = SITE_HOST) =>
    server.handleRequestForTest(new Request(`http://x${path}`, init), host)
  const key = (code: string) => ({ "X-API-Key": code })
  const keyZip = (code: string) => ({ "X-API-Key": code, "Content-Type": "application/zip" })

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-scoped-"))
    runtime = new FakeRuntime()
    server = makeServer(dataDir, runtime)
    await deploy("blog", { "public/index.html": "<h1>original</h1>", "pb_migrations/1_init.js": "// schema" })
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  test("the scoped health probe works unauthenticated on the site host", async () => {
    const res = await sReq("/_siteio/health", { method: "GET" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiResponse<{ status: string; version?: string }>
    expect(body.data!.status).toBe("ok")
    expect(body.data!.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  test("a scoped code can download its own site via /_siteio", async () => {
    const code = await mintCode("blog")
    const res = await sReq("/_siteio/sites/blog/download", { method: "GET", headers: key(code) })
    expect(res.status).toBe(200)
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()))
    expect(new TextDecoder().decode(files["public/index.html"]!)).toBe("<h1>original</h1>")
  })

  test("a scoped code can deploy its own site; backend preserved by default", async () => {
    const code = await mintCode("blog", { label: "Sam" })
    const res = await sReq("/_siteio/sites/blog", {
      method: "POST", headers: keyZip(code),
      // Invitee uploads new web + a smuggled migration — the migration must be ignored.
      body: zip({ "public/index.html": "<h1>via cli</h1>", "pb_migrations/9_evil.js": "DROP" }),
    })
    expect(res.status).toBe(200)
    const info = (await res.json()) as ApiResponse<SiteInfo>
    expect(info.data!.status).toBe("running")

    const dl = await sReq("/sites/blog/download", { method: "GET", headers: GOD }, "localhost")
    const files = unzipSync(new Uint8Array(await dl.arrayBuffer()))
    const dec = (k: string) => new TextDecoder().decode(files[k]!)
    expect(dec("public/index.html")).toBe("<h1>via cli</h1>")
    expect(dec("pb_migrations/1_init.js")).toBe("// schema") // preserved
    expect(files["pb_migrations/9_evil.js"]).toBeUndefined() // rejected
  })

  test("--allow-backend lets a scoped code change migrations", async () => {
    const code = await mintCode("blog", { allowBackend: true })
    await sReq("/_siteio/sites/blog", {
      method: "POST", headers: keyZip(code),
      body: zip({ "public/index.html": "<h1>x</h1>", "pb_migrations/2_add.js": "// new migration" }),
    })
    const dl = await sReq("/sites/blog/download", { method: "GET", headers: GOD }, "localhost")
    const files = unzipSync(new Uint8Array(await dl.arrayBuffer()))
    expect(new TextDecoder().decode(files["pb_migrations/2_add.js"]!)).toBe("// new migration")
    expect(files["pb_migrations/1_init.js"]).toBeUndefined() // replaced
  })

  test("scoped deploy is attributed to the grant label and is repeatable until revoked", async () => {
    const code = await mintCode("blog", { label: "Sam" })
    // Two deploys succeed — no budget limit.
    expect((await sReq("/_siteio/sites/blog", { method: "POST", headers: keyZip(code), body: zip({ "public/index.html": "hi" }) })).status).toBe(200)
    expect((await sReq("/_siteio/sites/blog", { method: "POST", headers: keyZip(code), body: zip({ "public/index.html": "hi2" }) })).status).toBe(200)

    // The god owner sees a history version attributed to the label.
    await deploy("blog", { "public/index.html": "owner" }) // archive the Sam version
    const hist = await sReq("/sites/blog/history", { method: "GET", headers: GOD }, "localhost")
    const body = (await hist.json()) as ApiResponse<SiteVersion[]>
    expect(body.data!.some((v) => v.deployedBy === "Sam")).toBe(true)
  })

  test("a scoped code cannot touch another site (wrong host or wrong path)", async () => {
    await deploy("shop", { "public/index.html": "<h1>shop</h1>" })
    const code = await mintCode("blog")
    // Used on shop's host → host/site mismatch.
    expect((await sReq("/_siteio/sites/shop/download", { method: "GET", headers: key(code) }, "shop.example.com")).status).toBe(403)
    // Used on blog's host but pointing at shop → path/site mismatch.
    expect((await sReq("/_siteio/sites/shop/download", { method: "GET", headers: key(code) })).status).toBe(403)
  })

  test("a scoped code cannot use owner-only routes (even via /_siteio)", async () => {
    const code = await mintCode("blog")
    expect((await sReq("/_siteio/sites", { method: "GET", headers: key(code) })).status).toBe(403)
    expect((await sReq("/_siteio/sites/blog", { method: "DELETE", headers: key(code) })).status).toBe(403)
    expect((await sReq("/_siteio/sites/blog/admin", { method: "GET", headers: key(code) })).status).toBe(403)
    expect((await sReq("/_siteio/apps", { method: "GET", headers: key(code) })).status).toBe(403)
    expect(
      (await sReq("/_siteio/sites/blog/rename", {
        method: "PATCH", headers: { "X-API-Key": code, "Content-Type": "application/json" },
        body: JSON.stringify({ newSubdomain: "hijack" }),
      })).status
    ).toBe(403)
  })

  test("the god key is refused on the scoped site-host channel", async () => {
    // The management surface is only reachable with a share code here.
    expect((await sReq("/_siteio/sites/blog/download", { method: "GET", headers: GOD })).status).toBe(403)
  })

  test("a revoked code stops authenticating over the CLI", async () => {
    const code = await mintCode("blog")
    expect((await sReq("/_siteio/sites/blog/download", { method: "GET", headers: key(code) })).status).toBe(200)
    const list = (await (
      await sReq("/sites/blog/grants", { method: "GET", headers: GOD }, "localhost")
    ).json()) as ApiResponse<{ id: string }[]>
    await sReq(`/sites/blog/grants/${list.data![0]!.id}`, { method: "DELETE", headers: GOD }, "localhost")
    expect((await sReq("/_siteio/sites/blog/download", { method: "GET", headers: key(code) })).status).toBe(401)
  })

  test("the god key still has full access on the api host (unchanged)", async () => {
    expect((await sReq("/sites", { method: "GET", headers: GOD }, "localhost")).status).toBe(200)
  })
})
