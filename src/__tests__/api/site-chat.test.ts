import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, ChatConfig, ChatEvent, ChatMessage } from "../../types.ts"
import type { ChatExecutor, ExecutorRunInput, ExecutorResult } from "../../lib/agent/chat/executor.ts"

const GOD = { "X-API-Key": "test-key" }
const GOD_ZIP = { ...GOD, "Content-Type": "application/zip" }
const GOD_JSON = { ...GOD, "Content-Type": "application/json" }

const CHAT: ChatConfig = {
  provider: "anthropic", model: "claude-sonnet-5", sandbox: false,
  sandboxImage: "x", sandboxNetwork: "n", maxTurns: 5, timeoutMs: 5000, oauthToken: "tok",
}

class FakeExecutor implements ChatExecutor {
  constructor(private opts: { write?: string } = {}) {}
  async run(input: ExecutorRunInput): Promise<ExecutorResult> {
    input.onEvent({ kind: "assistant_text", text: "on it" } satisfies ChatEvent)
    input.onEvent({ kind: "tool_call", name: "Edit", detail: "index.html" } satisfies ChatEvent)
    if (this.opts.write !== undefined) writeFileSync(join(input.workspaceDir, "index.html"), this.opts.write)
    return { finalText: "Done.", isError: false, aborted: false, timedOut: false }
  }
}

function makeServer(dataDir: string, opts: { chat?: ChatConfig; executor?: ChatExecutor } = {}): AgentServer {
  const config: AgentConfig = {
    apiKey: "test-key", dataDir, domain: "example.com",
    maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443,
    email: "ops@example.com", skipTraefik: true, chat: opts.chat,
  }
  return new AgentServer(config, new FakeRuntime(), { chatExecutor: opts.executor })
}

// Parse an SSE response body into the list of `data:` events (ignores heartbeats).
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
      method: "POST",
      headers: GOD_ZIP,
      body: zipSync({ "public/index.html": new TextEncoder().encode(html) }),
    })
  )
  expect(res.status).toBe(200)
}

describe("API: site chat", () => {
  let dataDir: string
  let server: AgentServer

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-site-chat-"))
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  test("chat is disabled when no LLM credential is configured", async () => {
    server = makeServer(dataDir) // no chat
    await deploySite(server, "blog", "<h1>Old</h1>")

    const site: any = await (await server.handleRequestForTest(new Request("http://x/sites/blog", { headers: GOD }))).json()
    expect(site.data.chatEnabled).toBe(false)

    const post = await server.handleRequestForTest(
      new Request("http://x/sites/blog/chat", { method: "POST", headers: GOD_JSON, body: JSON.stringify({ message: "hi" }) })
    )
    expect(post.status).toBe(400)
  })

  test("configured: a turn edits the site, deploys a new version, and persists the transcript", async () => {
    server = makeServer(dataDir, { chat: CHAT, executor: new FakeExecutor({ write: "<h1>New</h1>" }) })
    await deploySite(server, "blog", "<h1>Old</h1>")

    // Tab visibility + status
    const site: any = await (await server.handleRequestForTest(new Request("http://x/sites/blog", { headers: GOD }))).json()
    expect(site.data.chatEnabled).toBe(true)
    expect(site.data.version).toBe(1)

    const chat0: any = await (await server.handleRequestForTest(new Request("http://x/sites/blog/chat", { headers: GOD }))).json()
    expect(chat0.data.status.configured).toBe(true)
    expect(chat0.data.status.model).toBe("claude-sonnet-5")
    expect(chat0.data.messages).toEqual([])

    // Run a turn (SSE)
    const res = await server.handleRequestForTest(
      new Request("http://x/sites/blog/chat", { method: "POST", headers: GOD_JSON, body: JSON.stringify({ message: "make it new" }) })
    )
    expect(res.headers.get("Content-Type")).toContain("text/event-stream")
    const events = parseSse(await res.text())

    const done = events.find((e) => e.kind === "done") as Extract<ChatEvent, { kind: "done" }> | undefined
    expect(done).toBeDefined()
    const msg = done!.message as ChatMessage
    expect(msg.status).toBe("ok")
    expect(msg.deployed).toBe(true)
    expect(msg.versionBefore).toBe(1)
    expect(msg.versionAfter).toBe(2)
    expect(events.some((e) => e.kind === "deploy_progress")).toBe(true)

    // Site version bumped
    const site2: any = await (await server.handleRequestForTest(new Request("http://x/sites/blog", { headers: GOD }))).json()
    expect(site2.data.version).toBe(2)

    // Transcript persisted (user + assistant)
    const chat1: any = await (await server.handleRequestForTest(new Request("http://x/sites/blog/chat", { headers: GOD }))).json()
    expect(chat1.data.messages.map((m: ChatMessage) => m.role)).toEqual(["user", "assistant"])
  })

  test("a question turn (no file change) does not deploy", async () => {
    server = makeServer(dataDir, { chat: CHAT, executor: new FakeExecutor({}) }) // writes nothing
    await deploySite(server, "blog", "<h1>Old</h1>")
    const res = await server.handleRequestForTest(
      new Request("http://x/sites/blog/chat", { method: "POST", headers: GOD_JSON, body: JSON.stringify({ message: "hello?" }) })
    )
    const events = parseSse(await res.text())
    const done = events.find((e) => e.kind === "done") as Extract<ChatEvent, { kind: "done" }>
    expect(done.message.status).toBe("no_changes")
    const site: any = await (await server.handleRequestForTest(new Request("http://x/sites/blog", { headers: GOD }))).json()
    expect(site.data.version).toBe(1) // unchanged
  })

  test("empty message yields an error event", async () => {
    server = makeServer(dataDir, { chat: CHAT, executor: new FakeExecutor({ write: "x" }) })
    await deploySite(server, "blog", "<h1>Old</h1>")
    const res = await server.handleRequestForTest(
      new Request("http://x/sites/blog/chat", { method: "POST", headers: GOD_JSON, body: JSON.stringify({ message: "  " }) })
    )
    const events = parseSse(await res.text())
    expect(events.some((e) => e.kind === "error")).toBe(true)
  })

  test("DELETE clears history; deleting the site clears it too", async () => {
    server = makeServer(dataDir, { chat: CHAT, executor: new FakeExecutor({ write: "<h1>New</h1>" }) })
    await deploySite(server, "blog", "<h1>Old</h1>")
    await server.handleRequestForTest(
      new Request("http://x/sites/blog/chat", { method: "POST", headers: GOD_JSON, body: JSON.stringify({ message: "go" }) })
    ).then((r) => r.text())

    const del = await server.handleRequestForTest(new Request("http://x/sites/blog/chat", { method: "DELETE", headers: GOD }))
    expect(del.status).toBe(200)
    const chat: any = await (await server.handleRequestForTest(new Request("http://x/sites/blog/chat", { headers: GOD }))).json()
    expect(chat.data.messages).toEqual([])
  })

  test("renaming a site moves its chat transcript", async () => {
    server = makeServer(dataDir, { chat: CHAT, executor: new FakeExecutor({ write: "<h1>New</h1>" }) })
    await deploySite(server, "blog", "<h1>Old</h1>")
    await server.handleRequestForTest(
      new Request("http://x/sites/blog/chat", { method: "POST", headers: GOD_JSON, body: JSON.stringify({ message: "go" }) })
    ).then((r) => r.text())

    const rn = await server.handleRequestForTest(
      new Request("http://x/sites/blog/rename", { method: "PATCH", headers: GOD_JSON, body: JSON.stringify({ newSubdomain: "journal" }) })
    )
    expect(rn.status).toBe(200)

    const oldChat: any = await (await server.handleRequestForTest(new Request("http://x/sites/blog/chat", { headers: GOD }))).json()
    expect(oldChat.success).toBe(false) // site no longer exists
    const newChat: any = await (await server.handleRequestForTest(new Request("http://x/sites/journal/chat", { headers: GOD }))).json()
    expect(newChat.data.messages.length).toBe(2)
  })

  test("stop endpoint reports whether a turn was running", async () => {
    server = makeServer(dataDir, { chat: CHAT, executor: new FakeExecutor({ write: "x" }) })
    await deploySite(server, "blog", "<h1>Old</h1>")
    const res = await server.handleRequestForTest(new Request("http://x/sites/blog/chat/stop", { method: "POST", headers: GOD }))
    const body: any = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.stopped).toBe(false) // nothing running right now
  })
})
