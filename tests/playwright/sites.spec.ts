import { test, expect } from "@playwright/test"
import { startTestServer, type TestServerHandle } from "./helpers/server"

let srv: TestServerHandle

async function deploySite(url: string, apiKey: string, subdomain: string, files: Record<string, string>) {
  // Build a zip in memory using the fflate dependency already in the project
  const { zipSync, strToU8 } = await import("fflate")
  const entries: Record<string, Uint8Array> = {}
  for (const [k, v] of Object.entries(files)) entries[k] = strToU8(v)
  const zip = zipSync(entries)
  const res = await fetch(`${url}/sites/${subdomain}`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/zip" },
    body: zip,
  })
  if (!res.ok) throw new Error(`deploySite failed: ${res.status} ${await res.text()}`)
}

test.beforeAll(async () => {
  srv = await startTestServer({ apiKey: "right-key" })
  // Deploy alpha three times: history archives versions 1 and 2; current becomes v3.
  await deploySite(srv.url, srv.apiKey, "alpha", { "index.html": "<h1>v1</h1>" })
  await deploySite(srv.url, srv.apiKey, "alpha", { "index.html": "<h1>v2</h1>" })
  await deploySite(srv.url, srv.apiKey, "alpha", { "index.html": "<h1>v3</h1>" })
  await deploySite(srv.url, srv.apiKey, "beta",  { "index.html": "<h1>beta</h1>" })
})
test.afterAll(() => srv.cleanup())

test("sites list renders rows", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.goto(`${srv.url}/ui#/sites`)
  await expect(page.locator('tr[data-site-subdomain="alpha"]')).toBeVisible()
  await expect(page.locator('tr[data-site-subdomain="beta"]')).toBeVisible()
})

test("sites list row click navigates to detail", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.goto(`${srv.url}/ui#/sites`)
  await page.click('tr[data-site-subdomain="alpha"]')
  expect(new URL(page.url()).hash).toBe("#/sites/alpha")
  await expect(page.locator("h1", { hasText: "alpha" })).toBeVisible()
})

test("history sub-tab shows archived versions; rollback archives current and adds a new history row", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.goto(`${srv.url}/ui#/sites/alpha/history`)
  // After 3 deploys: current is v3, history has v1 and v2 (archived previous deploys).
  await expect(page.locator('tr[data-version="1"]')).toBeVisible()
  await expect(page.locator('tr[data-version="2"]')).toBeVisible()
  // Neither archived version matches the current version, so both expose Rollback.
  const rollbackBtn = page.locator('tr[data-version="1"] button', { hasText: "Rollback" })
  await expect(rollbackBtn).toBeEnabled()
  await rollbackBtn.click()
  // Rollback archives the prior current (v3) before activating v1 as a fresh deploy.
  // So after rollback, history contains v1, v2, v3, and the current version is v4 (not in history).
  await expect(page.locator('tr[data-version="3"]')).toBeVisible()
})

test("undeploy removes site and returns to list", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  page.on("dialog", (d) => d.accept())
  await page.goto(`${srv.url}/ui#/sites/beta`)
  await page.click('button:has-text("Undeploy")')
  await expect.poll(() => new URL(page.url()).hash).toBe("#/sites")
  await expect(page.locator('tr[data-site-subdomain="beta"]')).toHaveCount(0)
})
