import { test, expect } from "@playwright/test"
import { startTestServer, type TestServerHandle } from "./helpers/server"

let srv: TestServerHandle

test.beforeAll(async () => {
  srv = await startTestServer({ apiKey: "right-key" })
  await fetch(`${srv.url}/groups`, {
    method: "POST",
    headers: { "X-API-Key": srv.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "engineers", emails: ["a@example.com", "b@example.com"] }),
  })
  await fetch(`${srv.url}/groups`, {
    method: "POST",
    headers: { "X-API-Key": srv.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "ops", emails: [] }),
  })
})
test.afterAll(() => srv.cleanup())

test("groups list renders rows and expands on click", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.goto(`${srv.url}/ui#/groups`)
  await expect(page.locator('tr[data-group-name="engineers"]')).toBeVisible()
  await expect(page.locator('tr[data-group-name="ops"]')).toBeVisible()
  // Click expands the row to reveal emails
  await page.click('tr[data-group-name="engineers"]')
  await expect(page.getByText("a@example.com")).toBeVisible()
  await expect(page.getByText("b@example.com")).toBeVisible()
})
