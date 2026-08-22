import { test, expect } from "@playwright/test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { zipSync, strToU8 } from "fflate"
import { AgentServer } from "../../src/lib/agent/server"
import { FakeRuntime } from "../../src/__tests__/helpers/fake-runtime"
import type { AgentConfig, ChatConfig, EditLinkCreated } from "../../src/types"
import type { ChatExecutor, ExecutorRunInput, ExecutorResult } from "../../src/lib/agent/chat/executor"

// Deterministic stand-in agent: streams a step and edits index.html so the
// controller detects a change and (fake-)deploys a new version.
class FakeExecutor implements ChatExecutor {
  async run(input: ExecutorRunInput): Promise<ExecutorResult> {
    input.onEvent({ kind: "assistant_text", text: "Updating the headline…" })
    input.onEvent({ kind: "tool_call", name: "Edit", detail: "index.html" })
    writeFileSync(join(input.workspaceDir, "index.html"), "<h1>Changed By AI " + Date.now() + "</h1>")
    return { finalText: "Done — updated the headline.", isError: false, aborted: false, timedOut: false }
  }
}

const CHAT: ChatConfig = {
  provider: "anthropic", model: "claude-sonnet-5", sandbox: false,
  sandboxImage: "x", sandboxNetwork: "n", maxTurns: 5, timeoutMs: 5000, oauthToken: "tok",
}

const PORT = 4713
const DOMAIN = "siteio.test"
const API = `http://127.0.0.1:${PORT}`
const SHELL = `http://demo.${DOMAIN}:${PORT}/_siteio/edit`

let server: AgentServer
let dataDir: string

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "siteio-editor-shell-"))
  const config: AgentConfig = {
    domain: DOMAIN, apiKey: "god-key", dataDir, port: PORT, skipTraefik: true,
    maxUploadSize: 50 * 1024 * 1024, httpPort: 80, httpsPort: 443, chat: CHAT,
  }
  server = new AgentServer(config, new FakeRuntime(), { chatExecutor: new FakeExecutor() })
  await server.start()
  const res = await fetch(`${API}/sites/demo`, {
    method: "POST", headers: { "X-API-Key": "god-key", "Content-Type": "application/zip" },
    body: zipSync({ "public/index.html": strToU8("<h1>Old</h1>") }),
  })
  if (!res.ok) throw new Error(`deploy failed: ${res.status}`)
})

test.afterAll(() => {
  server.stop()
  try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

async function mintCode(): Promise<string> {
  const res = await fetch(`${API}/sites/demo/edit-link`, {
    method: "POST", headers: { "X-API-Key": "god-key", "Content-Type": "application/json" }, body: "{}",
  })
  const body = (await res.json()) as { data: EditLinkCreated }
  return body.data.code
}

test("welcome gate strips the code; framed iframe is sandboxed but functional", async ({ page }) => {
  const code = await mintCode()
  await page.goto(`${SHELL}#${code}`)

  await expect(page.getByRole("heading", { name: /Edit/ })).toBeVisible()
  await expect(page.getByText(/live to real visitors immediately/)).toBeVisible()
  await expect(page.getByRole("button", { name: "Start editing" })).toBeVisible()

  // The one-time code is stripped from the URL immediately (unfurler-safe: the
  // exchange only happens on the explicit gesture).
  expect(page.url()).not.toContain(code)
  expect(page.url()).not.toContain("#")

  // Phase 1: the framed site keeps allow-same-origin so dynamic sites work
  // (localStorage, same-origin /api). It is still sandboxed — no top-navigation,
  // so it can't hijack the shell. (Cross-origin isolation is Phase 2.)
  const sandbox = await page.locator("#site").getAttribute("sandbox")
  expect(sandbox).toContain("allow-scripts")
  expect(sandbox).toContain("allow-same-origin")
  expect(sandbox).not.toContain("allow-top-navigation")
})

test("start → send → streamed steps → change-is-live card with undo", async ({ page }) => {
  const code = await mintCode()
  await page.goto(`${SHELL}#${code}`)
  await page.getByRole("button", { name: "Start editing" }).click()

  // Panel opens on first entry.
  const input = page.locator("#input")
  await expect(input).toBeVisible()

  await input.fill("make the headline pop")
  await page.locator("#send").click()

  // User bubble appears.
  await expect(page.getByText("make the headline pop")).toBeVisible()

  // Turn-complete card leads with the live confirmation and offers undo, with
  // changed files tucked behind a details toggle.
  await expect(page.getByText("Your change is live")).toBeVisible()
  await expect(page.getByRole("button", { name: "Undo this change" })).toBeVisible()
  await expect(page.getByText(/1 file changed/)).toBeVisible()
  // Affordance triage: no clear-history control in the widget.
  await expect(page.getByRole("button", { name: /Clear/ })).toHaveCount(0)
})

test("undo rolls the change back", async ({ page }) => {
  const code = await mintCode()
  await page.goto(`${SHELL}#${code}`)
  await page.getByRole("button", { name: "Start editing" }).click()
  await page.locator("#input").fill("change something")
  await page.locator("#send").click()
  // The transcript accumulates across tests (shared server) — act on the latest.
  const undo = page.getByRole("button", { name: "Undo this change" }).last()
  await expect(undo).toBeVisible()

  const versionBefore = ((await (await fetch(`${API}/sites/demo`, { headers: { "X-API-Key": "god-key" } })).json()) as any).data.version
  await undo.click()

  // Version changes as the rollback deploys.
  await expect.poll(async () => {
    const s = (await (await fetch(`${API}/sites/demo`, { headers: { "X-API-Key": "god-key" } })).json()) as any
    return s.data.version
  }).not.toBe(versionBefore)
})

test("an already-expired/invalid code lands on a client terminal state, not a login", async ({ page }) => {
  await page.goto(`${SHELL}#grt_totallybogustokenvalue123456`)
  await page.getByRole("button", { name: "Start editing" }).click()
  await expect(page.getByRole("heading", { name: /can't be opened|expired/i })).toBeVisible()
  await expect(page.getByText(/Ask the site owner for a fresh editing link/)).toBeVisible()
})
