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

function makeServer(pagerUrl: string | undefined, port?: number): AgentServer {
  const config: AgentConfig = {
    apiKey: API_KEY,
    dataDir: join(dir, "data"),
    domain: "pager.test",
    maxUploadSize: 1024 * 1024,
    httpPort: 80,
    httpsPort: 443,
    skipTraefik: true,
    pagerUrl,
    port,
  }
  return new AgentServer(config, runtime)
}

function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000)
}

function pagerUrl(): string {
  return `http://localhost:${pagerServer.port}/p/secret`
}

async function call(
  server: AgentServer,
  method: string,
  path: string,
  body?: object | Uint8Array,
  headers: Record<string, string> = {}
): Promise<number> {
  const isZip = body instanceof Uint8Array
  const res = await server.handleRequestForTest(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "X-API-Key": API_KEY,
        ...(body && { "Content-Type": isZip ? "application/zip" : "application/json" }),
        ...headers,
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

  test("a failed app deploy pages the error", async () => {
    const server = makeServer(pagerUrl())
    await call(server, "POST", "/apps", { name: "web", image: "nginx", internalPort: 80 })
    runtime.pull = async () => {
      throw new Error("pull denied")
    }
    expect(await call(server, "POST", "/apps/web/deploy")).toBe(500)
    await settle()
    expect(pages).toHaveLength(1)
    expect(pages[0]!.title).toBe("App 'web' deploy failed")
    expect(pages[0]!.message).toBe("pull denied")
  })

  test("a deploy refused because one is in progress does not page", async () => {
    const server = makeServer(pagerUrl())
    await call(server, "POST", "/apps", { name: "web", image: "nginx", internalPort: 80 })
    let release!: () => void
    runtime.pull = () => new Promise<void>((r) => (release = r))
    const first = call(server, "POST", "/apps/web/deploy")
    await settle()
    expect(await call(server, "POST", "/apps/web/deploy")).toBe(409)
    release()
    expect(await first).toBe(200)
    await settle()
    expect(pages.map((p) => p.title)).toEqual(["App 'web' deployed"])
  })

  test("a deploy of an unknown app does not page", async () => {
    const server = makeServer(pagerUrl())
    expect(await call(server, "POST", "/apps/ghost/deploy")).toBe(404)
    await settle()
    expect(pages).toHaveLength(0)
  })

  test("a compose deploy pages on success and on failure", async () => {
    const server = makeServer(pagerUrl())
    const compose = "services:\n  web:\n    image: nginx\n"
    await call(server, "POST", "/apps", { name: "stack", composeContent: compose, primaryService: "web", internalPort: 80 })
    runtime.composeConfigReturn = { services: { web: {} } }
    expect(await call(server, "POST", "/apps/stack/deploy")).toBe(200)

    runtime.composeUp = async () => {
      throw new Error("port already allocated")
    }
    expect(await call(server, "POST", "/apps/stack/deploy")).toBe(500)
    await settle()
    expect(pages.map((p) => p.title)).toEqual(["App 'stack' deployed", "App 'stack' deploy failed"])
    expect(pages[1]!.message).toBe("port already allocated")
  })

  test("a compose deploy whose primary service is missing pages the failure", async () => {
    const server = makeServer(pagerUrl())
    const compose = "services:\n  web:\n    image: nginx\n"
    await call(server, "POST", "/apps", { name: "stack", composeContent: compose, primaryService: "web", internalPort: 80 })
    runtime.composeConfigReturn = { services: { other: {} } }
    expect(await call(server, "POST", "/apps/stack/deploy")).toBe(400)
    await settle()
    expect(pages).toHaveLength(1)
    expect(pages[0]!.title).toBe("App 'stack' deploy failed")
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

  test("a failed site deploy pages the error", async () => {
    const server = makeServer(pagerUrl())
    runtime.pull = async () => {
      throw new Error("registry down")
    }
    expect(await call(server, "POST", "/sites/blog", siteZip())).toBe(500)
    await settle()
    expect(pages).toHaveLength(1)
    expect(pages[0]!.title).toBe("Site 'blog' deploy failed")
    expect(pages[0]!.message).toBe("registry down")
    expect(pages[0]!.url).toBe("https://blog.pager.test")
  })

  test("a rejected site upload (empty zip) does not page", async () => {
    const server = makeServer(pagerUrl())
    expect(await call(server, "POST", "/sites/blog", new Uint8Array())).toBe(400)
    await settle()
    expect(pages).toHaveLength(0)
  })

  test("the agent pages once when it starts", async () => {
    const server = makeServer(pagerUrl(), randomPort())
    await server.start()
    try {
      await settle()
      expect(pages).toHaveLength(1)
      expect(pages[0]!.title).toBe("siteio agent started")
      expect(pages[0]!.message).toContain("on pager.test")
    } finally {
      server.stop()
    }
  })

  test("the agent starts even when the pager is unreachable", async () => {
    const deadUrl = pagerUrl()
    pagerServer.stop(true)
    const server = makeServer(deadUrl, randomPort())
    await server.start()
    server.stop()
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

describe("who made the change (X-Siteio-User)", () => {
  const as = (user: string) => ({ "X-Siteio-User": encodeURIComponent(user) })

  // Who the live version is attributed to. History only holds archived
  // versions, so a follow-up deploy archives the live one first.
  async function liveDeployedBy(server: AgentServer): Promise<string | undefined> {
    expect(await call(server, "POST", "/sites/blog", siteZip(), as("archiver"))).toBe(200)
    const res = await server.handleRequestForTest(
      new Request("http://localhost/sites/blog/history", { headers: { "X-API-Key": API_KEY } })
    )
    const history = ((await res.json()) as { data: { version: number; deployedBy?: string }[] }).data
    return history.reduce((a, b) => (b.version > a.version ? b : a)).deployedBy
  }

  test("app deploy, failed deploy and restart pages all name the decoded caller", async () => {
    const server = makeServer(pagerUrl())
    await call(server, "POST", "/apps", { name: "web", image: "nginx", internalPort: 80 })
    expect(await call(server, "POST", "/apps/web/deploy", undefined, as("Zoë 张"))).toBe(200)
    runtime.containerExistsReturn = true
    expect(await call(server, "POST", "/apps/web/restart", undefined, as("bob@laptop"))).toBe(200)
    runtime.pull = async () => {
      throw new Error("pull denied")
    }
    expect(await call(server, "POST", "/apps/web/deploy", undefined, as("eve"))).toBe(500)
    await settle()
    expect(pages.map((p) => p.message)).toEqual([
      "by Zoë 张 · on pager.test",
      "by bob@laptop · on pager.test",
      "pull denied · by eve",
    ])
  })

  test("a compose deploy names the caller too", async () => {
    const server = makeServer(pagerUrl())
    const compose = "services:\n  web:\n    image: nginx\n"
    await call(server, "POST", "/apps", { name: "stack", composeContent: compose, primaryService: "web", internalPort: 80 })
    runtime.composeConfigReturn = { services: { web: {} } }
    expect(await call(server, "POST", "/apps/stack/deploy", undefined, as("ada"))).toBe(200)
    await settle()
    expect(pages[0]!.message).toContain("by ada")
  })

  test("no header: pages carry no 'by' rather than 'by undefined'", async () => {
    const server = makeServer(pagerUrl())
    await call(server, "POST", "/apps", { name: "web", image: "nginx", internalPort: 80 })
    expect(await call(server, "POST", "/apps/web/deploy")).toBe(200)
    await settle()
    expect(pages[0]!.message).toBe("on pager.test")
  })

  test("a malformed percent-encoding is kept raw, never a 500", async () => {
    const server = makeServer(pagerUrl())
    expect(await call(server, "POST", "/sites/blog", siteZip(), { "X-Siteio-User": "100%zz" })).toBe(200)
    expect(await liveDeployedBy(server)).toBe("100%zz")
  })

  test("an older CLI's X-Deployed-By is still recorded", async () => {
    const server = makeServer(pagerUrl())
    expect(await call(server, "POST", "/sites/blog", siteZip(), { "X-Deployed-By": "old-cli" })).toBe(200)
    expect(await liveDeployedBy(server)).toBe("old-cli")
  })

  test("X-Siteio-User wins over X-Deployed-By when both are sent", async () => {
    const server = makeServer(pagerUrl())
    expect(await call(server, "POST", "/sites/blog", siteZip(), { "X-Deployed-By": "old-cli", ...as("new-cli") })).toBe(200)
    expect(await liveDeployedBy(server)).toBe("new-cli")
  })

  test("a rollback records who rolled back, not who deployed the restored version", async () => {
    const server = makeServer(pagerUrl())
    expect(await call(server, "POST", "/sites/blog", siteZip(), as("ada"))).toBe(200)
    expect(await call(server, "POST", "/sites/blog", siteZip(), as("ada"))).toBe(200)
    expect(await call(server, "POST", "/sites/blog/rollback", { version: 1 }, as("bob"))).toBe(200)
    expect(await liveDeployedBy(server)).toBe("bob")
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
