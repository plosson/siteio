import { test, expect } from "@playwright/test"
import { startTestServer, type TestServerHandle } from "./helpers/server"

let srv: TestServerHandle

test.beforeAll(async () => { srv = await startTestServer({ apiKey: "right-key" }) })
test.afterAll(() => srv.cleanup())

test("favicon link is present", async ({ page }) => {
  await page.goto(`${srv.url}/ui`)
  const href = await page.locator('link[rel="icon"]').getAttribute("href")
  expect(href).toMatch(/^data:image\/svg\+xml/)
})

test("login input is focused on load", async ({ page }) => {
  await page.goto(`${srv.url}/ui`)
  await expect(page.locator("#apiKeyInput")).toBeFocused()
})

test("Esc on logs pane stops auto-refresh", async ({ page, context }) => {
  // Seed an app and open logs
  await fetch(`${srv.url}/apps`, {
    method: "POST",
    headers: { "X-API-Key": "right-key", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "escapp", image: "nginx:alpine", internalPort: 80 }),
  })
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.goto(`${srv.url}/ui#/apps/escapp/logs`)
  await expect(page.locator('input[type="checkbox"]')).toBeChecked()
  await page.keyboard.press("Escape")
  await expect(page.locator('input[type="checkbox"]')).not.toBeChecked()
})
