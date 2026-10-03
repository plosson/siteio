import { test, expect } from "@playwright/test"
import { startTestServer, type TestServerHandle } from "./helpers/server"

let srv: TestServerHandle

test.beforeAll(async () => {
  srv = await startTestServer({ apiKey: "right-key" })
  // Seed two apps directly through the API (same path the CLI uses).
  await fetch(`${srv.url}/apps`, {
    method: "POST",
    headers: { "X-API-Key": srv.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "app-one", image: "nginx:alpine", internalPort: 80 }),
  })
  await fetch(`${srv.url}/apps`, {
    method: "POST",
    headers: { "X-API-Key": srv.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "app-two", image: "redis:7-alpine", internalPort: 6379 }),
  })
})
test.afterAll(() => srv.cleanup())

test("apps appear in the Apps list and clicking one navigates to detail", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.goto(`${srv.url}/ui#/apps`)

  // List populates with both apps
  await expect(page.locator('[data-service-name="app-one"]')).toBeVisible()
  await expect(page.locator('[data-service-name="app-two"]')).toBeVisible()

  // Click a row → hash changes to app detail
  await page.click('[data-service-name="app-one"]')
  expect(new URL(page.url()).hash).toBe("#/apps/app-one")
})

test("filter keeps only matching rows, and says so when nothing matches", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.goto(`${srv.url}/ui#/apps`)
  await expect(page.locator('[data-service-name="app-one"]')).toBeVisible()

  // "/" focuses the filter from anywhere on the page
  await page.keyboard.press("/")
  await expect(page.locator("#filterInput")).toBeFocused()

  // Matches visible text (the image), not only the name
  await page.keyboard.type("redis")
  await expect(page.locator('[data-service-name="app-two"]')).toBeVisible()
  await expect(page.locator('[data-service-name="app-one"]')).toHaveCount(0)

  await page.fill("#filterInput", "no-such-thing")
  await expect(page.locator("[data-service-name]")).toHaveCount(0)
  await expect(page.getByText("Nothing matches")).toBeVisible()
})

test("sites never show up in the Apps list", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.route(`${srv.url}/sites`, (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ success: true, data: [{ name: "a-site", url: "https://a-site.test.example.com", domains: [], status: "running", size: 1, pocketbaseVersion: "0", createdAt: new Date().toISOString() }] }),
  }))
  await page.goto(`${srv.url}/ui#/apps`)
  await expect(page.locator('[data-service-name="app-one"]')).toBeVisible()
  await expect(page.locator('[data-service-name="a-site"]')).toHaveCount(0)
})
