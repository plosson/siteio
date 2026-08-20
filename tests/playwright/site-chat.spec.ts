import { test, expect } from "@playwright/test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { zipSync, strToU8 } from "fflate"
import { AgentServer } from "../../src/lib/agent/server"
import { FakeRuntime } from "../../src/__tests__/helpers/fake-runtime"
import type { AgentConfig, ChatConfig } from "../../src/types"
import type { ChatExecutor, ExecutorRunInput, ExecutorResult } from "../../src/lib/agent/chat/executor"

// A deterministic stand-in for the real agent: streams a couple of events and
// edits index.html so the controller detects a change and (fake-)deploys v2.
// This drives the whole UI without a real LLM, container, or PocketBase.
class FakeExecutor implements ChatExecutor {
  async run(input: ExecutorRunInput): Promise<ExecutorResult> {
    input.onEvent({ kind: "assistant_text", text: "Updating the headline…" })
    input.onEvent({ kind: "tool_call", name: "Edit", detail: "index.html" })
    writeFileSync(join(input.workspaceDir, "index.html"), "<h1>Changed By AI</h1>")
    return { finalText: "Done — updated the headline.", isError: false, aborted: false, timedOut: false }
  }
}

const CHAT: ChatConfig = {
  provider: "anthropic", model: "claude-sonnet-5", sandbox: false,
  sandboxImage: "x", sandboxNetwork: "n", maxTurns: 5, timeoutMs: 5000, oauthToken: "tok",
}

let server: AgentServer
let dataDir: string
let url: string

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "siteio-chat-ui-"))
  const port = 4711
  const config: AgentConfig = {
    domain: "test.example.com", apiKey: "right-key", dataDir, port, skipTraefik: true,
    maxUploadSize: 50 * 1024 * 1024, httpPort: 80, httpsPort: 443, chat: CHAT,
  }
  server = new AgentServer(config, new FakeRuntime(), { chatExecutor: new FakeExecutor() })
  await server.start()
  url = `http://127.0.0.1:${port}`
  const res = await fetch(`${url}/sites/demo`, {
    method: "POST",
    headers: { "X-API-Key": "right-key", "Content-Type": "application/zip" },
    body: zipSync({ "public/index.html": strToU8("<h1>Old</h1>") }),
  })
  if (!res.ok) throw new Error(`deploy failed: ${res.status}`)
})

test.afterAll(() => {
  server.stop()
  try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

test("chat tab shows empty state, active model, and example prompts", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.goto(`${url}/ui#/sites/demo/chat`)
  await expect(page.getByText("Edit this site by chatting")).toBeVisible()
  await expect(page.getByText("claude-sonnet-5")).toBeVisible()
  await expect(page.getByText("sandboxed")).toBeHidden() // x-show off when sandbox:false
})

test("sending a message streams, deploys a new version, and offers revert", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.goto(`${url}/ui#/sites/demo/chat`)

  await page.fill("textarea", "change the headline")
  await page.getByRole("button", { name: "Send" }).click()

  // The user message bubble appears...
  await expect(page.getByText("change the headline")).toBeVisible()
  // ...and the completed assistant turn shows the deploy + revert affordance.
  await expect(page.getByText("Deployed v2")).toBeVisible()
  await expect(page.getByRole("button", { name: /Revert this change/ })).toBeVisible()
  // Changed-files summary is surfaced.
  await expect(page.getByText(/1 file: index\.html/)).toBeVisible()
})

test("chat tab is hidden when a site reports chat disabled", async ({ page, context }) => {
  // Point the UI at a site payload with chatEnabled=false by using a second
  // agent without chat configured.
  const dir2 = mkdtempSync(join(tmpdir(), "siteio-chat-off-"))
  const port2 = 4712
  const s2 = new AgentServer(
    {
      domain: "off.example.com", apiKey: "k2", dataDir: dir2, port: port2, skipTraefik: true,
      maxUploadSize: 50 * 1024 * 1024, httpPort: 80, httpsPort: 443,
    } as AgentConfig,
    new FakeRuntime()
  )
  await s2.start()
  try {
    await fetch(`http://127.0.0.1:${port2}/sites/demo`, {
      method: "POST", headers: { "X-API-Key": "k2", "Content-Type": "application/zip" },
      body: zipSync({ "public/index.html": strToU8("<h1>Off</h1>") }),
    })
    await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "k2"))
    await page.goto(`http://127.0.0.1:${port2}/ui#/sites/demo/overview`)
    await expect(page.getByRole("button", { name: "Overview" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Chat" })).toHaveCount(0)
  } finally {
    s2.stop()
    try { rmSync(dir2, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})
