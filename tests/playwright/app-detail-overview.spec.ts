import { test, expect } from "@playwright/test"
import { startTestServer, type TestServerHandle } from "./helpers/server"

let srv: TestServerHandle

test.beforeAll(async () => {
  srv = await startTestServer({ apiKey: "right-key" })
  await fetch(`${srv.url}/apps`, {
    method: "POST",
    headers: { "X-API-Key": srv.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "demo",
      image: "nginx:alpine",
      internalPort: 80,
      env: { FOO: "bar", NODE_ENV: "production" },
      restartPolicy: "always",
    }),
  })
})
test.afterAll(() => srv.cleanup())

test("app detail renders overview fields", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.goto(`${srv.url}/ui#/apps/demo`)

  await expect(page.locator("h1", { hasText: "demo" })).toBeVisible()
  await expect(page.getByText("nginx:alpine")).toBeVisible()
  await expect(page.getByText("FOO")).toBeVisible()
  await expect(page.getByText("bar")).toBeVisible()
  await expect(page.getByText("NODE_ENV")).toBeVisible()
  await expect(page.getByText("always").first()).toBeVisible()
})

test("unknown app shows not-found empty state", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.goto(`${srv.url}/ui#/apps/nope-does-not-exist`)
  await expect(page.getByText("App not found")).toBeVisible()
})
