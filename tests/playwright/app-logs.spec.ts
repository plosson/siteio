import { test, expect, type Route } from "@playwright/test"
import { startTestServer, type TestServerHandle } from "./helpers/server"

let srv: TestServerHandle

test.beforeAll(async () => {
  srv = await startTestServer({ apiKey: "right-key" })
  await fetch(`${srv.url}/apps`, {
    method: "POST",
    headers: { "X-API-Key": srv.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "logsapp", image: "nginx:alpine", internalPort: 80 }),
  })
})
test.afterAll(() => srv.cleanup())

test("logs pane fetches and renders tail", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  // Intercept /apps/logsapp/logs to return canned output
  let hitCount = 0
  await page.route(`${srv.url}/apps/logsapp/logs?*`, async (route: Route) => {
    hitCount++
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: { name: "logsapp", logs: `line from server #${hitCount}\n`, lines: 200 } }),
    })
  })

  await page.goto(`${srv.url}/ui#/apps/logsapp/logs`)
  await expect(page.locator("pre.logs")).toContainText("line from server")
  // With auto-refresh on (default), at least 2 requests after ~4 seconds
  await page.waitForTimeout(4000)
  expect(hitCount).toBeGreaterThan(1)
})

test("pausing auto-refresh stops polling", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  let hitCount = 0
  await page.route(`${srv.url}/apps/logsapp/logs?*`, async (route: Route) => {
    hitCount++
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: { name: "logsapp", logs: "hello\n", lines: 200 } }),
    })
  })

  await page.goto(`${srv.url}/ui#/apps/logsapp/logs`)
  // Uncheck the auto-refresh checkbox, then wait briefly for any in-flight poll to settle
  await page.uncheck('input[type="checkbox"]')
  await page.waitForTimeout(500)
  const before = hitCount
  await page.waitForTimeout(4000)
  // Strict: absolutely no polls after pause took effect
  expect(hitCount).toBe(before)
})

test("logs of a removed app stop polling and raise no error toasts", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  let hitCount = 0
  await page.route(`${srv.url}/apps/gone-app/logs?*`, (route: Route) => { hitCount++; return route.continue() })
  await page.goto(`${srv.url}/ui#/apps/gone-app/logs`)
  await expect(page.getByText("App not found")).toHaveCount(1) // the heading only, no toast
  await page.waitForTimeout(3500)
  expect(hitCount).toBeLessThanOrEqual(1)
  await expect(page.locator(".toast")).toHaveCount(0)
})

test("a log read error shows inside the viewer, once, not as repeated toasts", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.route(`${srv.url}/apps/logsapp/logs?*`, (route: Route) => route.fulfill({
    status: 500, contentType: "application/json",
    body: JSON.stringify({ success: false, error: "No such container: siteio-logsapp" }),
  }))
  await page.goto(`${srv.url}/ui#/apps/logsapp/logs`)
  await expect(page.locator("pre.logs")).toContainText("Can't read the logs. No such container")
  await page.waitForTimeout(3500) // at least one more poll
  await expect(page.locator(".toast")).toHaveCount(0)
})
