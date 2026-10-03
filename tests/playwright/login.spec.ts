import { test, expect } from "@playwright/test"
import { startTestServer, type TestServerHandle } from "./helpers/server"

let srv: TestServerHandle

test.beforeAll(async () => { srv = await startTestServer({ apiKey: "right-key" }) })
test.afterAll(() => srv.cleanup())

test("invalid API key shows inline error", async ({ page }) => {
  await page.goto(`${srv.url}/ui`)
  await page.fill("#apiKeyInput", "wrong-key")
  await page.click('button[type="submit"]')
  await expect(page.locator("#login-error")).toContainText("not valid")
  // The field is marked invalid for assistive tech, not only by colour.
  await expect(page.locator("#apiKeyInput")).toHaveAttribute("aria-invalid", "true")
  // still on login view
  await expect(page.locator("#login-view")).toBeVisible()
})

test("empty API key is refused without calling the server", async ({ page }) => {
  let calls = 0
  await page.route(`${srv.url}/sites`, (route) => { calls++; return route.continue() })
  await page.goto(`${srv.url}/ui`)
  await page.fill("#apiKeyInput", "   ")
  await page.click('button[type="submit"]')
  await expect(page.locator("#login-error")).toContainText("Enter the API key")
  expect(calls).toBe(0)
})

test("valid API key signs in, shows the overview and keeps the link that was opened", async ({ page }) => {
  await page.goto(`${srv.url}/ui#/settings`)
  await page.fill("#apiKeyInput", "right-key")
  await page.click('button[type="submit"]')
  await expect(page.locator("header")).toBeVisible()
  await expect(page.locator("h1", { hasText: "Settings" })).toBeVisible()
  const stored = await page.evaluate(() => sessionStorage.getItem("siteio_api_key"))
  expect(stored).toBe("right-key")
})

test("logout clears session and returns to login", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.goto(`${srv.url}/ui`)
  await expect(page.locator("header")).toBeVisible()
  await page.click('header button:has-text("Sign out")')
  await expect(page.locator("#login-view")).toBeVisible()
  const stored = await page.evaluate(() => sessionStorage.getItem("siteio_api_key"))
  expect(stored).toBeNull()
})

test("401 on any authed fetch triggers session expiry", async ({ page, context }) => {
  // Seed a BAD key so any real fetch will 401
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "stale-key"))
  await page.goto(`${srv.url}/ui`)
  // On boot, the route-driven fetch for /apps fires with the stale key and 401s,
  // which flips authed=false and surfaces the session-expired message.
  await expect(page.locator("#login-view")).toBeVisible()
  await expect(page.locator("#login-error")).toContainText("session ended")
})
