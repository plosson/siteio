import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, ChatConfig, ChatEvent, EditLinkCreated, ShareGrantCreated } from "../../types.ts"
import type { ChatExecutor, ExecutorRunInput, ExecutorResult } from "../../lib/agent/chat/executor.ts"

const GOD = { "X-API-Key": "test-key" }
const GOD_ZIP = { ...GOD, "Content-Type": "application/zip" }
const GOD_JSON = { ...GOD, "Content-Type": "application/json" }
const SITE_HOST = "blog.example.com"

const CHAT: ChatConfig = {
  provider: "anthropic", model: "claude-sonnet-5", sandbox: false,
  sandboxImage: "x", sandboxNetwork: "n", maxTurns: 5, timeoutMs: 5000, oauthToken: "tok",
}

class FakeExecutor implements ChatExecutor {
  constructor(private write: string) {}
  async run(input: ExecutorRunInput): Promise<ExecutorResult> {
    input.onEvent({ kind: "tool_call", name: "Edit", detail: "index.html" } satisfies ChatEvent)
    writeFileSync(join(input.workspaceDir, "index.html"), this.write)
    return { finalText: "Done.", isError: false, aborted: false, timedOut: false }
  }
}

function makeServer(dataDir: string): AgentServer {
  const config: AgentConfig = {
    apiKey: "test-key", dataDir, domain: "example.com",
    maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443,
    email: "ops@example.com", skipTraefik: true, chat: CHAT,
  }
  return new AgentServer(config, new FakeRuntime(), { chatExecutor: new FakeExecutor("<h1>New</h1>") })
}

function parseSse(text: string): ChatEvent[] {
  const out: ChatEvent[] = []
  for (const frame of text.split("\n\n")) {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue
      const json = line.slice(5).trim()
      if (json) out.push(JSON.parse(json) as ChatEvent)
    }
  }
  return out
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

async function editCookie(server: AgentServer, name: string): Promise<string> {
  const mint = await server.handleRequestForTest(
    new Request(`http://x/sites/${name}/edit-link`, { method: "POST", headers: GOD_JSON, body: "{}" })
  )
  const code = ((await mint.json()) as { data: EditLinkCreated }).data.code
  const ex = await server.handleRequestForTest(
    new Request("https://x/_siteio/edit/session", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
    }),
    `${name}.example.com`
  )
  const m = (ex.headers.get("set-cookie") || "").match(/siteio_edit=([^;]+)/)!
  return `siteio_edit=${m[1]}`
}

describe("API: edit-session chat (scoped, kind-gated)", () => {
  let dataDir: string
  let server: AgentServer

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-edit-chat-"))
    server = makeServer(dataDir)
    await deploySite(server, "blog", "<h1>Old</h1>")
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  test("a cookie-authed scoped turn edits the site and deploys a new version", async () => {
    const cookie = await editCookie(server, "blog")

    // History GET works over the cookie.
    const hist = await server.handleRequestForTest(
      new Request("https://x/_siteio/sites/blog/chat", { headers: { cookie } }),
      SITE_HOST
    )
    expect(hist.status).toBe(200)

    // Run a turn.
    const res = await server.handleRequestForTest(
      new Request("https://x/_siteio/sites/blog/chat", {
        method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ message: "make it new" }),
      }),
      SITE_HOST
    )
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const events = parseSse(await res.text())
    const done = events.find((e) => e.kind === "done") as Extract<ChatEvent, { kind: "done" }> | undefined
    expect(done).toBeDefined()
    expect(done!.message.deployed).toBe(true)
    expect(done!.message.versionAfter).toBe(2)

    // Site version bumped.
    const site = (await (await server.handleRequestForTest(new Request("http://x/sites/blog", { headers: GOD }))).json()) as { data: { version: number } }
    expect(site.data.version).toBe(2)
  })

  test("a classic share grant cannot reach the chat surface", async () => {
    // Mint a classic share (login token → X-API-Key).
    const g = await server.handleRequestForTest(
      new Request("http://x/sites/blog/grants", { method: "POST", headers: GOD_JSON, body: "{}" })
    )
    const share = ((await g.json()) as { data: ShareGrantCreated }).data

    const res = await server.handleRequestForTest(
      new Request("https://x/_siteio/sites/blog/chat", {
        method: "POST", headers: { "X-API-Key": share.code, "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi" }),
      }),
      SITE_HOST
    )
    expect(res.status).toBe(403)

    // …but the classic share's normal scoped deploy still works.
    const dep = await server.handleRequestForTest(
      new Request("https://x/_siteio/sites/blog", {
        method: "POST", headers: { "X-API-Key": share.code, "Content-Type": "application/zip" },
        body: zipSync({ "public/index.html": new TextEncoder().encode("<h1>Shared</h1>") }),
      }),
      SITE_HOST
    )
    expect(dep.status).toBe(200)
  })

  test("clear-history is not exposed to the edit session", async () => {
    const cookie = await editCookie(server, "blog")
    const res = await server.handleRequestForTest(
      new Request("https://x/_siteio/sites/blog/chat", { method: "DELETE", headers: { cookie } }),
      SITE_HOST
    )
    expect(res.status).toBe(403)
  })
})
