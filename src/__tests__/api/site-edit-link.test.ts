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
      method: "POST",
      headers: GOD_ZIP,
      body: zipSync({ "public/index.html": new TextEncoder().encode(html) }),
    })
  )
  expect(res.status).toBe(200)
}

async function mint(server: AgentServer, name: string, body: object = {}): Promise<Response> {
  return server.handleRequestForTest(
    new Request(`http://x/sites/${name}/edit-link`, { method: "POST", headers: GOD_JSON, body: JSON.stringify(body) })
  )
}

describe("API: sites edit-link", () => {
  let dataDir: string
  let server: AgentServer

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-edit-link-"))
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  test("mint yields a platform-subdomain URL whose code resolves as an edit grant", async () => {
    server = makeServer(dataDir, { chat: CHAT })
    await deploySite(server, "srilanka", "<h1>Hi</h1>")

    const res = await mint(server, "srilanka", { label: "Acme design" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: EditLinkCreated }
    const created = body.data

    expect(created.url).toBe(`https://srilanka.example.com/_siteio/edit#${created.code}`)
    expect(created.grant.kind).toBe("edit")
    expect(created.grant.label).toBe("Acme design")
    expect(Date.parse(created.expiresAt)).toBeGreaterThan(Date.now())
    expect(created.grant.versionAtStart).toBe(1)
  })

  test("mint requires chat to be configured", async () => {
    server = makeServer(dataDir) // no chat
    await deploySite(server, "blog", "<h1>Hi</h1>")
    const res = await mint(server, "blog")
    expect(res.status).toBe(400)
  })

  test("mint requires the site to have been deployed at least once", async () => {
    server = makeServer(dataDir, { chat: CHAT })
    const res = await mint(server, "ghost")
    expect(res.status).toBe(404) // site does not exist yet
  })

  test("a custom-domain site still yields a platform-subdomain link", async () => {
    server = makeServer(dataDir, { chat: CHAT })
    await deploySite(server, "srilanka", "<h1>Hi</h1>")
    // Attach a custom domain.
    const dom = await server.handleRequestForTest(
      new Request("http://x/sites/srilanka/domains", {
        method: "PATCH", headers: GOD_JSON, body: JSON.stringify({ domains: ["trip.example.org"] }),
      })
    )
    expect(dom.status).toBe(200)

    const res = await mint(server, "srilanka")
    const created = ((await res.json()) as { data: EditLinkCreated }).data
    expect(created.url).toStartWith("https://srilanka.example.com/_siteio/edit#")
    expect(created.url).not.toContain("trip.example.org")
  })

  test("--revoke revokes outstanding edit links", async () => {
    server = makeServer(dataDir, { chat: CHAT })
    await deploySite(server, "blog", "<h1>Hi</h1>")
    await mint(server, "blog")
    await mint(server, "blog")

    const del = await server.handleRequestForTest(
      new Request("http://x/sites/blog/edit-link", { method: "DELETE", headers: GOD })
    )
    const body = (await del.json()) as { data: { revoked: number } }
    expect(body.data.revoked).toBe(2)

    // A second revoke finds nothing left.
    const del2 = await server.handleRequestForTest(
      new Request("http://x/sites/blog/edit-link", { method: "DELETE", headers: GOD })
    )
    expect(((await del2.json()) as { data: { revoked: number } }).data.revoked).toBe(0)
  })

  test("edit links do not appear in the site's classic share-links list", async () => {
    server = makeServer(dataDir, { chat: CHAT })
    await deploySite(server, "blog", "<h1>Hi</h1>")
    await mint(server, "blog")

    const grants = await server.handleRequestForTest(new Request("http://x/sites/blog/grants", { headers: GOD }))
    const list = ((await grants.json()) as { data: unknown[] }).data
    expect(list).toHaveLength(0)
  })
})
