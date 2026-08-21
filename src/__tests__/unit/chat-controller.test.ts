import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { SiteStorage } from "../../lib/agent/storage.ts"
import { ChatStore } from "../../lib/agent/chat-store.ts"
import { ChatController, ChatBusyError, ChatUnavailableError } from "../../lib/agent/chat/controller.ts"
import type { ChatConfig, ChatEvent, SiteInfo } from "../../types.ts"
import type { ChatExecutor, ExecutorRunInput, ExecutorResult } from "../../lib/agent/chat/executor.ts"

const CHAT: ChatConfig = {
  provider: "anthropic", sandbox: false, sandboxImage: "x", sandboxNetwork: "n",
  maxTurns: 5, timeoutMs: 5000, oauthToken: "test-token",
}

// Executor that simulates an agent: optionally writes a file into the workspace,
// can wait on a gate (to test concurrency), and can report an error/timeout.
class FakeExecutor implements ChatExecutor {
  constructor(
    private opts: {
      write?: string
      isError?: boolean
      timedOut?: boolean
      aborted?: boolean
      finalText?: string
      gate?: Promise<void>
    } = {}
  ) {}
  async run(input: ExecutorRunInput): Promise<ExecutorResult> {
    input.onEvent({ kind: "assistant_text", text: "working" } satisfies ChatEvent)
    input.onEvent({ kind: "tool_call", name: "Edit", detail: "index.html" } satisfies ChatEvent)
    if (this.opts.write !== undefined) writeFileSync(join(input.workspaceDir, "index.html"), this.opts.write)
    if (this.opts.gate) await this.opts.gate
    return {
      finalText: this.opts.finalText ?? "Done.",
      isError: !!this.opts.isError,
      aborted: !!this.opts.aborted,
      timedOut: !!this.opts.timedOut,
    }
  }
}

describe("Unit: ChatController", () => {
  let dataDir: string
  let sites: SiteStorage
  let chats: ChatStore
  let deployCalls: number

  const SITE = "blog"

  // A deploy that really applies the zip to the code store and bumps the version,
  // so downstream reads see the change (like runSiteDeploy without Docker).
  const makeDeploy =
    (fail = false) =>
    async (name: string, zip: Uint8Array): Promise<SiteInfo> => {
      deployCalls++
      if (fail) throw new Error("boom")
      const { version } = await sites.extractCode(name, zip)
      const updated = sites.update(name, { version, status: "running", deployedAt: new Date().toISOString() })!
      return sites.toInfo(updated, "example.com")
    }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-chat-ctrl-"))
    sites = new SiteStorage(dataDir)
    chats = new ChatStore(dataDir)
    deployCalls = 0
    // Seed a deployed site (v1) with a web root.
    sites.create({
      name: SITE, domains: [], pocketbaseVersion: "1", status: "running", size: 0,
      superuserEmail: "a@b.c", superuserPassword: "pw",
    })
    await sites.extractCode(SITE, zipSync({ "public/index.html": new TextEncoder().encode("<h1>Old</h1>") }))
    sites.update(SITE, { version: 1 })
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  const make = (executor: ChatExecutor, deploy = makeDeploy()) =>
    new ChatController({ chat: CHAT, sites, chats, dataDir, domain: "example.com", deploy, executor })

  const collect = () => {
    const events: ChatEvent[] = []
    return { events, onEvent: (e: ChatEvent) => events.push(e) }
  }

  test("edit turn deploys, records version before/after + changed files", async () => {
    const ctl = make(new FakeExecutor({ write: "<h1>New</h1>" }))
    const { events, onEvent } = collect()
    const msg = await ctl.runTurn({ siteName: SITE, userMessage: "change headline", onEvent })

    expect(msg.role).toBe("assistant")
    expect(msg.status).toBe("ok")
    expect(msg.deployed).toBe(true)
    expect(msg.versionBefore).toBe(1)
    expect(msg.versionAfter).toBe(2)
    expect(msg.changedFiles).toEqual(["index.html"])
    expect(deployCalls).toBe(1)
    // deploy_progress streamed
    expect(events.some((e) => e.kind === "deploy_progress")).toBe(true)
    // transcript has user + assistant
    const t = chats.list(SITE)
    expect(t.map((m) => m.role)).toEqual(["user", "assistant"])
  })

  test("no-op turn does not deploy and is marked no_changes", async () => {
    const ctl = make(new FakeExecutor({})) // writes nothing
    const { onEvent } = collect()
    const msg = await ctl.runTurn({ siteName: SITE, userMessage: "why is the sky blue?", onEvent })
    expect(msg.status).toBe("no_changes")
    expect(msg.deployed).toBeFalsy()
    expect(deployCalls).toBe(0)
  })

  test("identical rewrite is not a change", async () => {
    const ctl = make(new FakeExecutor({ write: "<h1>Old</h1>" }))
    const { onEvent } = collect()
    const msg = await ctl.runTurn({ siteName: SITE, userMessage: "rewrite same", onEvent })
    expect(msg.status).toBe("no_changes")
    expect(deployCalls).toBe(0)
  })

  test("agent error skips deploy and records error", async () => {
    const ctl = make(new FakeExecutor({ write: "<h1>New</h1>", isError: true, finalText: "model failed" }))
    const { onEvent } = collect()
    const msg = await ctl.runTurn({ siteName: SITE, userMessage: "do it", onEvent })
    expect(msg.status).toBe("error")
    expect(msg.text).toContain("model failed")
    expect(deployCalls).toBe(0)
  })

  test("deploy failure surfaces as an error message", async () => {
    const ctl = make(new FakeExecutor({ write: "<h1>New</h1>" }), makeDeploy(true))
    const { onEvent } = collect()
    const msg = await ctl.runTurn({ siteName: SITE, userMessage: "do it", onEvent })
    expect(msg.status).toBe("error")
    expect(msg.text).toContain("deploy failed")
  })

  test("timeout is reported without deploy", async () => {
    const ctl = make(new FakeExecutor({ write: "<h1>New</h1>", timedOut: true }))
    const { onEvent } = collect()
    const msg = await ctl.runTurn({ siteName: SITE, userMessage: "do it", onEvent })
    expect(msg.status).toBe("error")
    expect(msg.text).toContain("timed out")
    expect(deployCalls).toBe(0)
  })

  test("a second concurrent turn for the same site is rejected as busy", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const ctl = make(new FakeExecutor({ write: "<h1>New</h1>", gate }))
    const { onEvent } = collect()
    const first = ctl.runTurn({ siteName: SITE, userMessage: "one", onEvent })
    expect(ctl.isActive(SITE)).toBe(true)
    await expect(ctl.runTurn({ siteName: SITE, userMessage: "two", onEvent })).rejects.toBeInstanceOf(ChatBusyError)
    release()
    await first
    expect(ctl.isActive(SITE)).toBe(false)
  })

  test("refuses a never-deployed site", async () => {
    sites.create({
      name: "draft", domains: [], pocketbaseVersion: "1", status: "pending", size: 0,
      superuserEmail: "a@b.c", superuserPassword: "pw",
    })
    const ctl = make(new FakeExecutor({ write: "x" }))
    const { onEvent } = collect()
    await expect(ctl.runTurn({ siteName: "draft", userMessage: "hi", onEvent })).rejects.toBeInstanceOf(
      ChatUnavailableError
    )
  })

  test("empty message is rejected", async () => {
    const ctl = make(new FakeExecutor())
    const { onEvent } = collect()
    await expect(ctl.runTurn({ siteName: SITE, userMessage: "   ", onEvent })).rejects.toBeInstanceOf(
      ChatUnavailableError
    )
  })
})
