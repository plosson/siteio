import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server"
import { Pager } from "../../lib/agent/pager"
import { FakeRuntime } from "../helpers/fake-runtime"
import type { AgentConfig } from "../../types"

const API_KEY = "pager-test-key"

// A fake pagerio endpoint recording every page it receives.
let pages: Record<string, unknown>[]
let pagerStatus: number
let pagerServer: ReturnType<typeof Bun.serve>
let dir: string
let runtime: FakeRuntime

beforeEach(() => {
  pages = []
  pagerStatus = 202
  pagerServer = Bun.serve({
    port: 0,
    async fetch(req) {
      pages.push((await req.json()) as Record<string, unknown>)
      return new Response("{}", { status: pagerStatus })
    },
  })
  dir = mkdtempSync(join(tmpdir(), "siteio-pager-"))
  runtime = new FakeRuntime()
})

afterEach(() => {
  pagerServer.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

function makeServer(pagerUrl: string | undefined): AgentServer {
  const config: AgentConfig = {
    apiKey: API_KEY,
    dataDir: join(dir, "data"),
    domain: "pager.test",
    maxUploadSize: 1024 * 1024,
    httpPort: 80,
    httpsPort: 443,
    skipTraefik: true,
    pagerUrl,
  }
  return new AgentServer(config, runtime)
}

function pagerUrl(): string {
  return `http://localhost:${pagerServer.port}/p/secret`
}

async function call(server: AgentServer, method: string, path: string, body?: object | Uint8Array): Promise<number> {
  const isZip = body instanceof Uint8Array
  const res = await server.handleRequestForTest(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "X-API-Key": API_KEY,
        ...(body && { "Content-Type": isZip ? "application/zip" : "application/json" }),
      },
      body: body ? (isZip ? body : JSON.stringify(body)) : undefined,
    })
  )
  return res.status
}

// Pages are fire-and-forget; give the in-flight POST time to land.
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 100))
}

const siteZip = () => zipSync({ "public/index.html": new TextEncoder().encode("<h1>hi</h1>") })

describe("pager", () => {
  test("no PAGERIO_URL: deploys and restarts page nobody", async () => {
    const server = makeServer(undefined)
    expect(await call(server, "POST", "/apps", { name: "web", image: "nginx", internalPort: 80 })).toBe(200)
    expect(await call(server, "POST", "/apps/web/deploy")).toBe(200)
    expect(await call(server, "POST", "/sites/blog", siteZip())).toBe(200)
    await settle()
    expect(pages).toHaveLength(0)
  })

  test("an app deploy pages once, with the app URL", async () => {
    const server = makeServer(pagerUrl())
    await call(server, "POST", "/apps", { name: "web", image: "nginx", internalPort: 80 })
    await settle()
    expect(pages).toHaveLength(0) // creating is not deploying

    expect(await call(server, "POST", "/apps/web/deploy")).toBe(200)
    await settle()
    expect(pages).toHaveLength(1)
    expect(pages[0]!.title).toBe("App 'web' deployed")
    expect(pages[0]!.url).toBe("https://web.pager.test")
    expect(pages[0]!.group).toBe("siteio")
  })

  test("a failed app deploy does not page", async () => {
    const server = makeServer(pagerUrl())
    await call(server, "POST", "/apps", { name: "web", image: "nginx", internalPort: 80 })
    runtime.pull = async () => {
      throw new Error("pull denied")
    }
    expect(await call(server, "POST", "/apps/web/deploy")).toBe(500)
    await settle()
    expect(pages).toHaveLength(0)
  })

  test("an app restart pages; a restart of a never-deployed app does not", async () => {
    const server = makeServer(pagerUrl())
    await call(server, "POST", "/apps", { name: "web", image: "nginx", internalPort: 80 })
    expect(await call(server, "POST", "/apps/web/restart")).toBe(400) // no container yet
    await settle()
    expect(pages).toHaveLength(0)

    runtime.containerExistsReturn = true
    expect(await call(server, "POST", "/apps/web/restart")).toBe(200)
    await settle()
    expect(pages).toHaveLength(1)
    expect(pages[0]!.title).toBe("App 'web' restarted")
  })

  test("a site deploy pages with its version", async () => {
    const server = makeServer(pagerUrl())
    expect(await call(server, "POST", "/sites/blog", siteZip())).toBe(200)
    expect(await call(server, "POST", "/sites/blog", siteZip())).toBe(200)
    await settle()
    expect(pages.map((p) => p.title)).toEqual(["Site 'blog' deployed", "Site 'blog' deployed"])
    expect(pages[1]!.message).toContain("v2")
    expect(pages[1]!.url).toBe("https://blog.pager.test")
  })

  test("a failed site deploy does not page", async () => {
    const server = makeServer(pagerUrl())
    runtime.pull = async () => {
      throw new Error("registry down")
    }
    expect(await call(server, "POST", "/sites/blog", siteZip())).toBe(500)
    await settle()
    expect(pages).toHaveLength(0)
  })

  test("a pager error never fails the deploy", async () => {
    pagerStatus = 500
    const server = makeServer(pagerUrl())
    expect(await call(server, "POST", "/sites/blog", siteZip())).toBe(200)
    await settle()
    expect(pages).toHaveLength(1)
  })

  test("an unreachable pager never fails the deploy", async () => {
    const deadUrl = pagerUrl()
    pagerServer.stop(true)
    const server = makeServer(deadUrl)
    expect(await call(server, "POST", "/sites/blog", siteZip())).toBe(200)
  })
})

describe("Pager.notify", () => {
  test("never rejects, and logs the failure, when the pager is unreachable", async () => {
    const url = pagerUrl()
    pagerServer.stop(true)
    const logs: string[] = []
    await new Pager(url, (l) => logs.push(l)).notify({ title: "t", message: "m" })
    expect(logs[0]).toContain("Pager failed")
  })

  test("logs a rejected page (e.g. 429 rate limit) without throwing", async () => {
    pagerStatus = 429
    const logs: string[] = []
    await new Pager(pagerUrl(), (l) => logs.push(l)).notify({ title: "t", message: "m" })
    expect(logs[0]).toContain("429")
  })
})
