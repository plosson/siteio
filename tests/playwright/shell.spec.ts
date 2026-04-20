import { test, expect } from "@playwright/test"
import { startTestServer, type TestServerHandle } from "./helpers/server"

let srv: TestServerHandle

test.beforeAll(async () => { srv = await startTestServer() })
test.afterAll(() => srv.cleanup())

test("GET /ui renders the HTML shell", async ({ page }) => {
  await page.goto(`${srv.url}/ui`)
  // At boot with no session key, authed=false so login placeholder shows
  await expect(page.locator("#login-view")).toBeVisible()
  // Tailwind/Alpine loaded (body has x-data attribute applied; fonts loaded via link preconnect)
  await expect(page.locator("body")).toHaveAttribute("x-data", /siteioAdmin/)
})

test("with a session-storage key, sidebar renders", async ({ page, context }) => {
  // Pre-seed sessionStorage via an init script that runs before Alpine init.
  await context.addInitScript(() => {
    sessionStorage.setItem("siteio_api_key", "test-api-key")
  })
  await page.goto(`${srv.url}/ui`)
  await expect(page.locator("aside")).toBeVisible()
  await expect(page.locator('aside a[href="#/apps"]')).toBeVisible()
  await expect(page.locator('aside a[href="#/sites"]')).toBeVisible()
  await expect(page.locator('aside a[href="#/groups"]')).toBeVisible()
  await expect(page.locator("aside button", { hasText: "Logout" })).toBeVisible()
})
