import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync, strToU8 } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, ApiResponse, ShareGrantCreated } from "../../types.ts"

const MB = 1024 * 1024
const GOD = { "X-API-Key": "god-key" }
const GOD_ZIP = { ...GOD, "Content-Type": "application/zip" }
const GOD_JSON = { ...GOD, "Content-Type": "application/json" }

describe("API: uploaded zip limits", () => {
  let dataDir: string
  let server: AgentServer

  const post = (path: string, body: Uint8Array, headers: Record<string, string> = GOD_ZIP, host = "localhost") =>
    server.handleRequestForTest(new Request(`http://x${path}`, { method: "POST", headers, body }), host)
  const liveIndex = () => readFileSync(join(dataDir, "pocket-code", "blog", "public", "index.html"), "utf8")
  const bomb = () => zipSync({ "public/zeros.bin": new Uint8Array(4 * MB) }, { level: 9 })
  const many = () => {
    const files: Record<string, Uint8Array> = {}
    for (let i = 0; i < 25; i++) files[`public/f${i}.txt`] = strToU8("x")
    return zipSync(files)
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-ziplimits-"))
    const config: AgentConfig = {
      apiKey: "god-key", dataDir, domain: "example.com",
      maxUploadSize: 50 * MB, maxUnzippedSize: 1 * MB, maxZipEntries: 20,
      httpPort: 8080, httpsPort: 8443, skipTraefik: true,
    }
    server = new AgentServer(config, new FakeRuntime())
    const res = await post("/sites/blog", zipSync({ "public/index.html": strToU8("<h1>original</h1>") }))
    expect(res.status).toBe(200)
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  test("a normal zip still deploys", async () => {
    const res = await post("/sites/blog", zipSync({ "public/index.html": strToU8("<h1>v2</h1>") }))
    expect(res.status).toBe(200)
    expect(liveIndex()).toBe("<h1>v2</h1>")
  })

  test("a high-ratio zip over the budget is 413 and the live site is untouched", async () => {
    const zip = bomb()
    expect(zip.length).toBeLessThan(64 * 1024)
    const res = await post("/sites/blog", zip)
    expect(res.status).toBe(413)
    expect(((await res.json()) as ApiResponse<unknown>).error).toMatch(/expands to more than 1MB/)
    expect(liveIndex()).toBe("<h1>original</h1>")
  })

  test("too many entries is 413", async () => {
    const res = await post("/sites/blog", many())
    expect(res.status).toBe(413)
    expect(((await res.json()) as ApiResponse<unknown>).error).toMatch(/more than 20 entries/)
    expect(liveIndex()).toBe("<h1>original</h1>")
  })

  test("a body that is not a zip is 400", async () => {
    const res = await post("/sites/blog", strToU8("not a zip at all"))
    expect(res.status).toBe(400)
    expect(liveIndex()).toBe("<h1>original</h1>")
  })

  test("a share-code deploy enforces the same limits", async () => {
    const mint = await server.handleRequestForTest(
      new Request("http://x/sites/blog/grants", { method: "POST", headers: GOD_JSON, body: "{}" })
    )
    const code = ((await mint.json()) as ApiResponse<ShareGrantCreated>).data!.code
    const headers = { "X-API-Key": code, "Content-Type": "application/zip" }
    expect((await post("/_siteio/sites/blog", bomb(), headers, "blog.example.com")).status).toBe(413)
    expect((await post("/_siteio/sites/blog", many(), headers, "blog.example.com")).status).toBe(413)
    expect(liveIndex()).toBe("<h1>original</h1>")
    const ok = await post("/_siteio/sites/blog", zipSync({ "public/index.html": strToU8("<h1>shared</h1>") }), headers, "blog.example.com")
    expect(ok.status).toBe(200)
    expect(liveIndex()).toBe("<h1>shared</h1>")
  })
})
