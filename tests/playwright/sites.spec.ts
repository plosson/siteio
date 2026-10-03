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

test("sites appear in the Sites list with their status in words", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.goto(`${srv.url}/ui#/sites`)
  await expect(page.locator('[data-service-name="alpha"]')).toBeVisible()
  // Status is a symbol plus a word, never colour alone.
  await expect(page.locator('[data-service-name="alpha"] .status')).toHaveText(/^[✓✗⟳] \w+/)
  await expect(page.locator('[data-service-name="beta"]')).toBeVisible()
})

test("clicking a site row navigates to site detail", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.goto(`${srv.url}/ui#/sites`)
  await page.click('[data-service-name="alpha"]')
  expect(new URL(page.url()).hash).toBe("#/sites/alpha")
  await expect(page.locator("h1", { hasText: "alpha" })).toBeVisible()
})

test("history sub-tab shows archived versions; rollback archives current and adds a new history row", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.goto(`${srv.url}/ui#/sites/alpha/history`)
  // After 3 deploys: current is v3, history has v1 and v2 (archived previous deploys).
  await expect(page.locator('li[data-version="1"]')).toBeVisible()
  await expect(page.locator('li[data-version="2"]')).toBeVisible()
  await expect(page.locator("li[data-current]")).toContainText("v3")
  // Neither archived version matches the current version, so both expose Restore.
  const restoreBtn = page.locator('li[data-version="1"] button', { hasText: "Restore" })
  await expect(restoreBtn).toBeEnabled()

  // Cancelling the confirmation changes nothing.
  await restoreBtn.click()
  await page.locator('dialog[open] button:has-text("Cancel")').click()
  await expect(page.locator('li[data-version="3"]')).toHaveCount(0)

  await restoreBtn.click()
  // The confirmation says what comes back and what doesn't.
  await expect(page.locator("dialog[open]")).toContainText("data stays")
  await page.locator('dialog[open] button:has-text("Restore v1")').click()
  // Restore archives the prior current (v3) before activating v1 as a fresh deploy.
  // So after it, history contains v1, v2, v3, and the live version is v4 (not in history).
  await expect(page.locator('li[data-version="3"]')).toBeVisible()
  await expect(page.locator("li[data-current]")).toContainText("v4")
})

test("undeploy removes site and returns to list", async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem("siteio_api_key", "right-key"))
  await page.goto(`${srv.url}/ui#/sites/beta`)
  await page.click('button:has-text("Remove site")')
  await page.locator('dialog[open] button:has-text("Remove site")').click()
  // Removal returns to the Sites list, with beta's row gone.
  await expect.poll(() => new URL(page.url()).hash).toBe("#/sites")
  await expect(page.locator('[data-service-name="alpha"]')).toBeVisible()
  await expect(page.locator('[data-service-name="beta"]')).toHaveCount(0)
})
