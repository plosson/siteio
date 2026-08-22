import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/playwright",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // The in-site editor shell is served on a site host (<site>.<domain>),
        // not localhost. Map the test domain to the loopback agent so the shell
        // spec can drive the real /_siteio/edit route through the host router.
        launchOptions: { args: ["--host-resolver-rules=MAP *.siteio.test 127.0.0.1"] },
      },
    },
  ],
})
