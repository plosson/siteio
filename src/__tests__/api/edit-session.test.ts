import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, ChatConfig, EditLinkCreated } from "../../types.ts"

const GOD = { "X-API-Key": "test-key" }
const GOD_ZIP = { ...GOD, "Content-Type": "application/zip" }
const GOD_JSON = { ...GOD, "Content-Type": "application/json" }

const CHAT: ChatConfig = {
  provider: "anthropic", model: "claude-sonnet-5", sandbox: false,
  sandboxImage: "x", sandboxNetwork: "n", maxTurns: 5, timeoutMs: 5000, oauthToken: "tok",
}

function makeServer(dataDir: string, opts: { chat?: ChatConfig } = {}): AgentServer {
  const config: AgentConfig = {
    apiKey: "test-key", dataDir, domain: "example.com",
    maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443,
    email: "ops@example.com", skipTraefik: true, chat: opts.chat,
  }
  return new AgentServer(config, new FakeRuntime())
}

async function deploySite(server: AgentServer, name: string, html: string): Promise<void> {
  const res = await server.handleRequestForTest(
    new Request(`http://x/sites/${name}`, {
      method: "POST", headers: GOD_ZIP,
      body: zipSync({ "public/index.html": new TextEncoder().encode(html) }),
    })
  )
  expect(res.status).toBe(200)
}

async function mintCode(server: AgentServer, name: string): Promise<string> {
  const res = await server.handleRequestForTest(
    new Request(`http://x/sites/${name}/edit-link`, { method: "POST", headers: GOD_JSON, body: "{}" })
  )
  const body = (await res.json()) as { data: EditLinkCreated }
  return body.data.code
}

// Pull the siteio_edit cookie value out of a Set-Cookie header.
function sessionCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie") || ""
  const m = setCookie.match(/siteio_edit=([^;]+)/)
  if (!m) throw new Error("no session cookie in response: " + setCookie)
  return `siteio_edit=${m[1]}`
}

const SITE_HOST = "blog.example.com"

describe("API: edit session (carve-outs + cookie exchange)", () => {
  let dataDir: string
  let server: AgentServer

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-edit-session-"))
    server = makeServer(dataDir, { chat: CHAT })
    await deploySite(server, "blog", "<h1>Old</h1>")
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  test("the shell is served unauthenticated with anti-clickjacking headers", async () => {
    const res = await server.handleRequestForTest(
      new Request("https://x/_siteio/edit", { method: "GET" }),
      SITE_HOST
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")

    const html = await res.text()
    // Placeholders resolved, no leftovers.
    expect(html).not.toContain("__SITE_NAME__")
    expect(html).not.toContain("/*__CHAT_CORE__*/")
    // Site name injected + shared transport inlined.
    expect(html).toContain('var SITE = "blog"')
    expect(html).toContain("window.SiteioChat")
    // Phase 1 (owner-only): the framed site keeps allow-same-origin so dynamic
    // sites (localStorage, same-origin /api) actually function; the true
    // cross-origin isolation is Phase 2 (separate editor origin). Still no
    // allow-top-navigation, so the frame can't hijack the shell.
    expect(html).toMatch(/sandbox="[^"]*allow-scripts[^"]*"/)
    expect(html).toContain("allow-same-origin")
    expect(html).not.toContain("allow-top-navigation")
  })

  test("exchange consumes a code, sets an HttpOnly /_siteio cookie, and returns the framed site URL", async () => {
    const code = await mintCode(server, "blog")
    const res = await server.handleRequestForTest(
      new Request("https://x/_siteio/edit/session", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
      }),
      SITE_HOST
    )
    expect(res.status).toBe(200)
    const setCookie = res.headers.get("set-cookie") || ""
    expect(setCookie).toContain("siteio_edit=")
    expect(setCookie).toContain("HttpOnly")
    expect(setCookie).toContain("SameSite=Strict")
    expect(setCookie).toContain("Path=/_siteio")
    expect(setCookie).toContain("Secure") // request was https
    const body = (await res.json()) as { data: { siteUrl: string; versionAtStart: number } }
    expect(body.data.siteUrl).toBe("https://blog.example.com/")
    expect(body.data.versionAtStart).toBe(1)
  })

  test("the cookie authenticates scoped requests on /_siteio", async () => {
    const code = await mintCode(server, "blog")
    const ex = await server.handleRequestForTest(
      new Request("https://x/_siteio/edit/session", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
      }),
      SITE_HOST
    )
    const cookie = sessionCookie(ex)

    // With the cookie, a scoped GET resolves the site.
    const ok = await server.handleRequestForTest(
      new Request("https://x/_siteio/sites/blog", { headers: { cookie } }),
      SITE_HOST
    )
    expect(ok.status).toBe(200)

    // Without it, the same request is 401.
    const no = await server.handleRequestForTest(
      new Request("https://x/_siteio/sites/blog"),
      SITE_HOST
    )
    expect(no.status).toBe(401)
  })

  test("re-exchange within TTL re-establishes a session and revokes the prior one", async () => {
    const code = await mintCode(server, "blog")
    const first = await server.handleRequestForTest(
      new Request("https://x/_siteio/edit/session", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
      }),
      SITE_HOST
    )
    const firstCookie = sessionCookie(first)

    const second = await server.handleRequestForTest(
      new Request("https://x/_siteio/edit/session", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
      }),
      SITE_HOST
    )
    const secondCookie = sessionCookie(second)
    expect(secondCookie).not.toBe(firstCookie)

    // The new session works; the old one is dead.
    const withNew = await server.handleRequestForTest(
      new Request("https://x/_siteio/sites/blog", { headers: { cookie: secondCookie } }),
      SITE_HOST
    )
    expect(withNew.status).toBe(200)
    const withOld = await server.handleRequestForTest(
      new Request("https://x/_siteio/sites/blog", { headers: { cookie: firstCookie } }),
      SITE_HOST
    )
    expect(withOld.status).toBe(401)
  })

  test("an unknown code is rejected with a client reason", async () => {
    const res = await server.handleRequestForTest(
      new Request("https://x/_siteio/edit/session", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "grt_bogusbogusbogusbogus" }),
      }),
      SITE_HOST
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as { success: boolean; reason: string }
    expect(body.success).toBe(false)
    expect(body.reason).toBe("invalid")
  })

  test("a code minted for one site cannot open the editor on another", async () => {
    await deploySite(server, "shop", "<h1>Shop</h1>")
    const code = await mintCode(server, "blog")
    const res = await server.handleRequestForTest(
      new Request("https://x/_siteio/edit/session", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
      }),
      "shop.example.com"
    )
    expect(res.status).toBe(403)
  })

  test("revoking the edit link kills a live cookie session (revoke cascade)", async () => {
    const code = await mintCode(server, "blog")
    const ex = await server.handleRequestForTest(
      new Request("https://x/_siteio/edit/session", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
      }),
      SITE_HOST
    )
    const cookie = sessionCookie(ex)

    // Owner revokes all edit links for the site.
    await server.handleRequestForTest(new Request("http://x/sites/blog/edit-link", { method: "DELETE", headers: GOD }))

    const after = await server.handleRequestForTest(
      new Request("https://x/_siteio/sites/blog", { headers: { cookie } }),
      SITE_HOST
    )
    expect(after.status).toBe(401)
  })
})
