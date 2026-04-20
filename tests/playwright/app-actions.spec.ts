import { test, expect, type Route } from "@playwright/test"
import { startTestServer, type TestServerHandle } from "./helpers/server"

let srv: TestServerHandle

test.beforeAll(async () => {
  srv = await startTestServer({ apiKey: "right-key" })
  await fetch(`${srv.url}/apps`, {
    method: "POST",
    headers: { "X-API-Key": srv.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "actionable", image: "nginx:alpine", internalPort: 80 }),
  })
})
test.afterAll(() => srv.cleanup())

async function interceptActionEndpoints(page: any, capture: { path: string; method: string }[]) {
  // Intercept deploy/stop/restart/delete on this app and return a fake success
  const routes: string[] = [
    `${srv.url}/apps/actionable/deploy`,
    `${srv.url}/apps/actionable/stop`,
    `${srv.url}/apps/actionable/restart`,
    `${srv.url}/apps/actionable`,
  ]
  for (const url of routes) {
    await page.route(url, async (route: Route) => {
      const req = route.request()
      capture.push({ path: new URL(req.url()).pathname, method: req.method() })
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: { name: "actionable", status: "running" } }),
      })
    })
  }
}

test("deploy button calls POST /apps/:name/deploy", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  const capture: { path: string; method: string }[] = []
  await interceptActionEndpoints(page, capture)
  await page.goto(`${srv.url}/ui#/apps/actionable`)
  await page.click('button:has-text("Deploy")')
  await expect.poll(() => capture.find(c => c.path === "/apps/actionable/deploy" && c.method === "POST")).toBeTruthy()
})

test("stop button calls POST /apps/:name/stop", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  const capture: { path: string; method: string }[] = []
  await interceptActionEndpoints(page, capture)
  await page.goto(`${srv.url}/ui#/apps/actionable`)
  await page.click('button:has-text("Stop")')
  await expect.poll(() => capture.find(c => c.path === "/apps/actionable/stop" && c.method === "POST")).toBeTruthy()
})

test("restart button calls POST /apps/:name/restart", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  const capture: { path: string; method: string }[] = []
  await interceptActionEndpoints(page, capture)
  await page.goto(`${srv.url}/ui#/apps/actionable`)
  await page.click('button:has-text("Restart")')
  await expect.poll(() => capture.find(c => c.path === "/apps/actionable/restart" && c.method === "POST")).toBeTruthy()
})

test("remove button confirms then calls DELETE /apps/:name and returns to list", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  const capture: { path: string; method: string }[] = []
  await interceptActionEndpoints(page, capture)
  page.on("dialog", (d) => d.accept())
  await page.goto(`${srv.url}/ui#/apps/actionable`)
  await page.click('button:has-text("Remove")')
  await expect.poll(() => capture.find(c => c.path === "/apps/actionable" && c.method === "DELETE")).toBeTruthy()
  // Redirected to list
  await expect.poll(() => new URL(page.url()).hash).toBe("#/apps")
})
