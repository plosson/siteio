import { test, expect, type Frame, type Page } from "@playwright/test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { zipSync, strToU8 } from "fflate"
import { AgentServer } from "../../src/lib/agent/server"
import { FakeRuntime } from "../../src/__tests__/helpers/fake-runtime"
import type { AgentConfig, ChatConfig, EditLinkCreated } from "../../src/types"
import type { ChatExecutor, ExecutorRunInput, ExecutorResult } from "../../src/lib/agent/chat/executor"

// Records the message the agent actually receives (target preamble folded in
// server-side) and edits index.html so the controller deploys a new version.
// The server runs in this test process, so the spec can read `lastMessage` back
// after driving the real browser → SSE → controller loop.
class RecordingExecutor implements ChatExecutor {
  lastMessage = ""
  async run(input: ExecutorRunInput): Promise<ExecutorResult> {
    this.lastMessage = input.spec.userMessage
    input.onEvent({ kind: "assistant_text", text: "Applying…" })
    input.onEvent({ kind: "tool_call", name: "Edit", detail: "index.html" })
    writeFileSync(join(input.workspaceDir, "index.html"), "<h1>Edited " + Date.now() + "</h1>")
    return { finalText: "Done.", isError: false, aborted: false, timedOut: false }
  }
}

const CHAT: ChatConfig = {
  provider: "anthropic", model: "claude-sonnet-5", sandbox: false,
  sandboxImage: "x", sandboxNetwork: "n", maxTurns: 5, timeoutMs: 5000, oauthToken: "tok",
}

const PORT = 4714
const DOMAIN = "siteio.test"
const API = `http://127.0.0.1:${PORT}`
const SHELL = `http://demo.${DOMAIN}:${PORT}/_siteio/edit`

// A fixture with distinct, pickable elements: a unique-id headline, a classed
// tagline, and repeated list items (to exercise the nth-of-type path).
const FIXTURE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Demo</title>
<style>body{font-family:sans-serif} h1{color:rgb(17,24,39);font-size:40px}</style></head>
<body>
  <header class="hero"><h1 id="headline">Welcome to Acme</h1><p class="tagline">We build sturdy things.</p></header>
  <main><ul><li>Alpha</li><li>Bravo</li><li>Charlie</li></ul><button class="cta">Sign up</button></main>
</body></html>`

let server: AgentServer
let executor: RecordingExecutor
let dataDir: string

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "siteio-editor-picker-"))
  executor = new RecordingExecutor()
  const config: AgentConfig = {
    domain: DOMAIN, apiKey: "god-key", dataDir, port: PORT, skipTraefik: true,
    maxUploadSize: 50 * 1024 * 1024, httpPort: 80, httpsPort: 443, chat: CHAT,
  }
  server = new AgentServer(config, new FakeRuntime(), { chatExecutor: executor })
  await server.start()
  const res = await fetch(`${API}/sites/demo`, {
    method: "POST", headers: { "X-API-Key": "god-key", "Content-Type": "application/zip" },
    body: zipSync({ "public/index.html": strToU8(FIXTURE) }),
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
  return ((await res.json()) as { data: EditLinkCreated }).data.code
}

// The framed site is normally served by its container via Traefik; under
// skipTraefik the agent 404s the site-host "/". Serve the fixture in its place
// (same origin as the shell, so Phase-1 injection works) — every other route
// (the shell HTML, the /_siteio session + SSE chat) still hits the real server.
const SITE_ROOT_RE = new RegExp(`^http://demo\\.${DOMAIN.replace(/\./g, "\\.")}:${PORT}/(\\?.*)?$`)

// Enter the editor and return the framed site's Frame with the picker injected.
async function enterEditor(page: Page): Promise<Frame> {
  await page.route(SITE_ROOT_RE, (route) => {
    if (route.request().method() !== "GET") return route.continue()
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: FIXTURE })
  })
  const code = await mintCode()
  await page.goto(`${SHELL}#${code}`)
  await page.getByRole("button", { name: "Start editing" }).click()
  await expect(page.locator("#input")).toBeVisible()
  // The site iframe — NOT the shell's own main frame (whose URL also contains
  // the host, at /_siteio/edit).
  let frame: Frame | null = null
  await expect
    .poll(() => {
      frame =
        page.frames().find((f) => f !== page.mainFrame() && f.url().includes(`demo.${DOMAIN}`)) || null
      return !!frame
    }, { timeout: 5000 })
    .toBe(true)
  // Picker.js is injected on frame load; wait for its test hook to appear.
  await frame!.waitForFunction(() => !!(globalThis as any).__siteioPicker, null, { timeout: 5000 })
  return frame!
}

test("capture: selector resolves back to the node; text matches; long text is truncated", async ({ page }) => {
  const frame = await enterEditor(page)

  // Unique id wins.
  const headline = await frame.evaluate(() => {
    const g = globalThis as any
    const d = g.document
    const t = g.__siteioPicker.captureElement(d.querySelector("#headline"))
    return { t, resolves: d.querySelectorAll(t.selector).length, isNode: d.querySelector(t.selector) === d.querySelector("#headline") }
  })
  expect(headline.t.selector).toBe("#headline")
  expect(headline.t.tag).toBe("h1")
  expect(headline.t.text).toBe("Welcome to Acme")
  expect(headline.resolves).toBe(1)
  expect(headline.isNode).toBe(true)

  // A classed element resolves uniquely back to itself.
  const tagline = await frame.evaluate(() => {
    const g = globalThis as any
    const d = g.document
    const t = g.__siteioPicker.captureElement(d.querySelector(".tagline"))
    return { selector: t.selector, resolves: d.querySelectorAll(t.selector).length, isNode: d.querySelector(t.selector) === d.querySelector(".tagline") }
  })
  expect(tagline.resolves).toBe(1)
  expect(tagline.isNode).toBe(true)

  // A repeated element (3rd <li>) still resolves uniquely to the clicked node.
  const li = await frame.evaluate(() => {
    const g = globalThis as any
    const d = g.document
    const node = d.querySelectorAll("li")[2]
    const t = g.__siteioPicker.captureElement(node)
    return { selector: t.selector, text: t.text, resolves: d.querySelectorAll(t.selector).length, isNode: d.querySelector(t.selector) === node }
  })
  expect(li.text).toBe("Charlie")
  expect(li.resolves).toBe(1)
  expect(li.isNode).toBe(true)

  // Truncation caps the captured text (500 + ellipsis).
  const long = await frame.evaluate(() => {
    const g = globalThis as any
    const d = g.document
    const el = d.createElement("p")
    el.textContent = "x".repeat(2000)
    d.body.appendChild(el)
    const t = g.__siteioPicker.captureElement(el)
    return { len: t.text.length, ends: t.text.endsWith("…") }
  })
  expect(long.len).toBeLessThanOrEqual(501)
  expect(long.ends).toBe(true)
})

test("element pick → chip → send folds the anchor into the agent's message and deploys", async ({ page }) => {
  const frame = await enterEditor(page)

  // Toggle crosshair mode and click the headline in the frame.
  await page.locator("#pick").click()
  await expect(page.locator("#pick")).toHaveClass(/active/)
  await frame.locator("#headline").click()

  // The composer chip shows what was picked; crosshair mode auto-exits.
  await expect(page.locator("#target-chip")).toBeVisible()
  await expect(page.locator("#target-chip .tc-label")).toContainText("#headline")
  await expect(page.locator("#target-chip .tc-label")).toContainText("Welcome to Acme")
  await expect(page.locator("#pick")).not.toHaveClass(/active/)

  await page.locator("#input").fill("make this dark blue")
  await page.locator("#send").click()

  await expect(page.getByText("Your change is live")).toBeVisible()
  // The chip clears on send (one target per message)…
  await expect(page.locator("#target-chip")).toBeHidden()
  // …but the sent user bubble records the anchor, so it's clear it was attached
  // (and it survives the post-turn history refresh, since it's persisted).
  await expect(page.locator(".msg.user .msg-target").last()).toContainText("#headline")

  // The real browser → SSE → controller loop delivered the anchor (and, since
  // this is an appearance request, the captured styles) to the agent.
  expect(executor.lastMessage).toContain("selector: #headline")
  expect(executor.lastMessage).toContain("Welcome to Acme")
  expect(executor.lastMessage).toContain("make this dark blue")
  expect(executor.lastMessage).toContain("current styles")
})

test("text selection → 'edit this text' affordance → chip captures the run", async ({ page }) => {
  const frame = await enterEditor(page)

  // Select the tagline text; the in-frame affordance appears without the toggle.
  await frame.locator(".tagline").selectText()
  const editBtn = frame.locator('[data-siteio-overlay="text-edit"]')
  await expect(editBtn).toBeVisible()
  await editBtn.click()

  await expect(page.locator("#target-chip")).toBeVisible()
  await expect(page.locator("#target-chip .tc-label")).toContainText("sturdy things")

  await page.locator("#input").fill("fix this typo")
  await page.locator("#send").click()
  await expect(page.getByText("Your change is live")).toBeVisible()

  expect(executor.lastMessage).toContain("selected this text")
  expect(executor.lastMessage).toContain("sturdy things")
  expect(executor.lastMessage).toContain("fix this typo")
})

test("entering crosshair mode dismisses a live 'edit this text' affordance", async ({ page }) => {
  const frame = await enterEditor(page)
  await frame.locator(".tagline").selectText()
  const editBtn = frame.locator('[data-siteio-overlay="text-edit"]')
  await expect(editBtn).toBeVisible()

  // Toggling the picker must hide the floating button (it would otherwise be a
  // dead zone over the page in crosshair mode).
  await page.locator("#pick").click()
  await expect(editBtn).toBeHidden()
})

test("protocol isolation: a target message not from the framed iframe is ignored", async ({ page }) => {
  await enterEditor(page)

  // Forge a picker message from the shell's own window (event.source is the
  // shell window, not the iframe) — the shell must ignore it, so no chip.
  await page.evaluate(() => {
    ;(globalThis as any).postMessage(
      { source: "siteio-picker", type: "target", target: { kind: "element", selector: "#evil", text: "spoofed" } },
      "*"
    )
  })
  await page.waitForTimeout(200)
  await expect(page.locator("#target-chip")).toBeHidden()
})
