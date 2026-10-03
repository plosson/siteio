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

test("with a session-storage key, the header with sections renders", async ({ page, context }) => {
  // Pre-seed sessionStorage via an init script that runs before Alpine init.
  await context.addInitScript(() => {
    sessionStorage.setItem("siteio_api_key", "test-api-key")
  })
  await page.goto(`${srv.url}/ui`)
  const nav = page.locator('nav[aria-label="Sections"]')
  await expect(nav.locator('a[href="#/"]')).toHaveAttribute("aria-current", "page")
  await expect(nav.locator('a[href="#/sites"]')).toBeVisible()
  await expect(nav.locator('a[href="#/apps"]')).toBeVisible()
  await expect(nav.locator('a[href="#/settings"]')).toBeVisible()
  // Where you are: the server's domain, from the agent.
  await expect(page.locator("header")).toContainText("test.example.com")
  await expect(page.locator("header button", { hasText: "Sign out" })).toBeVisible()
  // No third-party fonts, icon sets or Tailwind: system fonts and our own CSS only.
  const urls = await page.locator("link[href], script[src]").evaluateAll((els: any[]) =>
    els.map((el) => el.getAttribute("href") || el.getAttribute("src") || ""))
  const external = urls.filter((u) => /^https?:/.test(u) && !u.includes("alpinejs"))
  expect(external).toEqual([])
})

test("an old #/services link lands on the overview", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "test-api-key"))
  await page.goto(`${srv.url}/ui#/services`)
  await expect.poll(() => new URL(page.url()).hash).toBe("#/")
  await expect(page.locator("h1", { hasText: "Overview" })).toBeVisible()
})
