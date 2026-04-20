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

test("apps list renders rows and row click navigates to detail", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.goto(`${srv.url}/ui`)

  // Table populates with both apps
  await expect(page.locator('tr[data-app-name="app-one"]')).toBeVisible()
  await expect(page.locator('tr[data-app-name="app-two"]')).toBeVisible()

  // Click a row → hash changes to app detail
  await page.click('tr[data-app-name="app-one"]')
  expect(new URL(page.url()).hash).toBe("#/apps/app-one")
})

test("refresh button reloads list", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.goto(`${srv.url}/ui`)
  await expect(page.locator('tr[data-app-name="app-one"]')).toBeVisible()
  await page.click('button:has-text("Refresh")')
  // After refresh the rows are still present
  await expect(page.locator('tr[data-app-name="app-one"]')).toBeVisible()
  await expect(page.locator('tr[data-app-name="app-two"]')).toBeVisible()
})
