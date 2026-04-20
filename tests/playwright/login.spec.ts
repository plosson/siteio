import { test, expect } from "@playwright/test"
import { startTestServer, type TestServerHandle } from "./helpers/server"

let srv: TestServerHandle

test.beforeAll(async () => { srv = await startTestServer({ apiKey: "right-key" }) })
test.afterAll(() => srv.cleanup())

test("invalid API key shows inline error", async ({ page }) => {
  await page.goto(`${srv.url}/ui`)
  await page.fill("#apiKeyInput", "wrong-key")
  await page.click('button[type="submit"]')
  await expect(page.locator("#login-error")).toContainText("Invalid API key")
  // still on login view
  await expect(page.locator("#login-view")).toBeVisible()
})

test("valid API key signs in and shows dashboard", async ({ page }) => {
  await page.goto(`${srv.url}/ui`)
  await page.fill("#apiKeyInput", "right-key")
  await page.click('button[type="submit"]')
  await expect(page.locator("aside")).toBeVisible()
  const stored = await page.evaluate(() => sessionStorage.getItem("siteio_api_key"))
  expect(stored).toBe("right-key")
})

test("logout clears session and returns to login", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.goto(`${srv.url}/ui`)
  await expect(page.locator("aside")).toBeVisible()
  await page.click('aside button:has-text("Logout")')
  await expect(page.locator("#login-view")).toBeVisible()
  const stored = await page.evaluate(() => sessionStorage.getItem("siteio_api_key"))
  expect(stored).toBeNull()
})

test("401 on any authed fetch triggers session expiry", async ({ page, context }) => {
  // Seed a BAD key so any real fetch will 401
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "stale-key"))
  await page.goto(`${srv.url}/ui`)
  // sidebar renders (authed flipped true at boot based on sessionStorage presence)
  await expect(page.locator("aside")).toBeVisible()
  // Manually trigger apiFetch which will 401 → flip to login with message.
  // Fire-and-forget so the page.evaluate promise resolves before Alpine swaps
  // templates (which otherwise races with the evaluate execution context).
  await page.evaluate(() => {
    // @ts-expect-error access Alpine root for test-only action
    const root = Alpine.$data(document.body)
    root.apiFetch("/sites").catch(() => { /* expected 401 */ })
  })
  await expect(page.locator("#login-view")).toBeVisible()
  await expect(page.locator("#login-error")).toContainText("Session expired")
})
