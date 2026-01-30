import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { spawn } from "bun"
import { AgentServer } from "../../lib/agent/server.ts"
import type { AgentConfig } from "../../types.ts"

const TEST_PORT = 4570
const TEST_API_KEY = "cli-auth-test-key"
const TEST_DOMAIN = "cli-auth.local"

describe("CLI: Sites Auth", () => {
  let server: AgentServer
  const dataDir = join(import.meta.dir, ".test-data-cli-auth")
  const configDir = join(import.meta.dir, ".test-config-cli-auth")
  const testSiteDir = join(import.meta.dir, ".test-site-cli-auth")

  async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = spawn({
      cmd: ["bun", "run", "src/cli.ts", ...args],
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: configDir,
        XDG_CONFIG_HOME: configDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    const exitCode = await proc.exited
    return { stdout, stderr, exitCode }
  }

  async function deploySite(subdomain: string): Promise<void> {
    const result = await runCli(["--json", "sites", "deploy", testSiteDir, "--subdomain", subdomain])
    if (result.exitCode !== 0) {
      throw new Error(`Failed to deploy site: ${result.stderr}`)
    }
  }

  async function deleteSite(subdomain: string): Promise<void> {
    await runCli(["sites", "rm", "-y", subdomain])
  }

  beforeAll(async () => {
    // Clean up any previous test data
    for (const dir of [dataDir, configDir, testSiteDir]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true })
      }
      mkdirSync(dir, { recursive: true })
    }

    // Create oauth-config.json to enable OAuth
    writeFileSync(
      join(dataDir, "oauth-config.json"),
      JSON.stringify({
        issuerUrl: "https://accounts.google.com",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        cookieSecret: "test-cookie-secret-32-chars-long!",
        cookieDomain: ".cli-auth.local",
      })
    )

    // Create groups for testing
    writeFileSync(
      join(dataDir, "groups.json"),
      JSON.stringify([
        { name: "admins", emails: ["admin@example.com"] },
        { name: "devs", emails: ["dev@example.com"] },
      ])
    )

    // Create test site content
    writeFileSync(join(testSiteDir, "index.html"), "<html><body>Test</body></html>")

    // Create CLI config
    const siteioConfigDir = join(configDir, ".config", "siteio")
    mkdirSync(siteioConfigDir, { recursive: true })
    writeFileSync(
      join(siteioConfigDir, "config.json"),
      JSON.stringify({
        apiUrl: `http://localhost:${TEST_PORT}`,
        apiKey: TEST_API_KEY,
      })
    )

    // Start server
    const config: AgentConfig = {
      apiKey: TEST_API_KEY,
      dataDir,
      domain: TEST_DOMAIN,
      maxUploadSize: 10 * 1024 * 1024,
      httpPort: 80,
      httpsPort: 443,
      skipTraefik: true,
      port: TEST_PORT,
    }

    server = new AgentServer(config)
    await server.start()
  })

  afterAll(() => {
    server.stop()
    for (const dir of [dataDir, configDir, testSiteDir]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true })
      }
    }
  })

  beforeEach(() => {
    // Clean up sites between tests
    const sitesDir = join(dataDir, "sites")
    const metadataDir = join(dataDir, "metadata")
    if (existsSync(sitesDir)) {
      rmSync(sitesDir, { recursive: true })
    }
    if (existsSync(metadataDir)) {
      rmSync(metadataDir, { recursive: true })
    }
    mkdirSync(sitesDir, { recursive: true })
    mkdirSync(metadataDir, { recursive: true })
  })

  test("should show sites auth help", async () => {
    const result = await runCli(["sites", "auth", "--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("--allowed-emails")
    expect(result.stdout).toContain("--allowed-domain")
    expect(result.stdout).toContain("--allowed-groups")
    expect(result.stdout).toContain("--remove")
  })

  test("should set OAuth with --allowed-emails", async () => {
    await deploySite("email-site")

    const result = await runCli(["--json", "sites", "auth", "email-site", "--allowed-emails", "user@example.com"])
    expect(result.exitCode).toBe(0)

    const json = JSON.parse(result.stdout)
    expect(json.success).toBe(true)
    expect(json.data.oauth.allowedEmails).toEqual(["user@example.com"])
  })

  test("should set OAuth with --allowed-domain", async () => {
    await deploySite("domain-site")

    const result = await runCli(["--json", "sites", "auth", "domain-site", "--allowed-domain", "company.com"])
    expect(result.exitCode).toBe(0)

    const json = JSON.parse(result.stdout)
    expect(json.success).toBe(true)
    expect(json.data.oauth.allowedDomain).toBe("company.com")
  })

  test("should set OAuth with --allowed-groups", async () => {
    await deploySite("group-site")

    const result = await runCli(["--json", "sites", "auth", "group-site", "--allowed-groups", "admins,devs"])
    expect(result.exitCode).toBe(0)

    const json = JSON.parse(result.stdout)
    expect(json.success).toBe(true)
    expect(json.data.oauth.allowedGroups).toEqual(["admins", "devs"])
  })

  test("should add email with --add-email", async () => {
    await deploySite("add-email-site")

    // Set initial email
    await runCli(["--json", "sites", "auth", "add-email-site", "--allowed-emails", "first@example.com"])

    // Add another email
    const result = await runCli(["--json", "sites", "auth", "add-email-site", "--add-email", "second@example.com"])
    expect(result.exitCode).toBe(0)

    const json = JSON.parse(result.stdout)
    expect(json.data.oauth.allowedEmails).toContain("first@example.com")
    expect(json.data.oauth.allowedEmails).toContain("second@example.com")
  })

  test("should remove email with --remove-email", async () => {
    await deploySite("remove-email-site")

    // Set initial emails
    await runCli(["--json", "sites", "auth", "remove-email-site", "--allowed-emails", "keep@example.com,remove@example.com"])

    // Remove one email
    const result = await runCli(["--json", "sites", "auth", "remove-email-site", "--remove-email", "remove@example.com"])
    expect(result.exitCode).toBe(0)

    const json = JSON.parse(result.stdout)
    expect(json.data.oauth.allowedEmails).toEqual(["keep@example.com"])
  })

  test("should add domain with --add-domain", async () => {
    await deploySite("add-domain-site")

    const result = await runCli(["--json", "sites", "auth", "add-domain-site", "--add-domain", "newdomain.com"])
    expect(result.exitCode).toBe(0)

    const json = JSON.parse(result.stdout)
    expect(json.data.oauth.allowedDomain).toBe("newdomain.com")
  })

  test("should remove domain with --remove-domain", async () => {
    await deploySite("remove-domain-site")

    // Set domain first
    await runCli(["--json", "sites", "auth", "remove-domain-site", "--allowed-domain", "example.com"])

    // Remove domain - should make site public since no other auth
    const result = await runCli(["--json", "sites", "auth", "remove-domain-site", "--remove-domain", "example.com"])
    expect(result.exitCode).toBe(0)

    const json = JSON.parse(result.stdout)
    expect(json.data.oauth).toBeNull()
  })

  test("should add group with --add-group", async () => {
    await deploySite("add-group-site")

    // Set initial group
    await runCli(["--json", "sites", "auth", "add-group-site", "--allowed-groups", "admins"])

    // Add another group
    const result = await runCli(["--json", "sites", "auth", "add-group-site", "--add-group", "devs"])
    expect(result.exitCode).toBe(0)

    const json = JSON.parse(result.stdout)
    expect(json.data.oauth.allowedGroups).toContain("admins")
    expect(json.data.oauth.allowedGroups).toContain("devs")
  })

  test("should remove group with --remove-group", async () => {
    await deploySite("remove-group-site")

    // Set initial groups
    await runCli(["--json", "sites", "auth", "remove-group-site", "--allowed-groups", "admins,devs"])

    // Remove one group
    const result = await runCli(["--json", "sites", "auth", "remove-group-site", "--remove-group", "devs"])
    expect(result.exitCode).toBe(0)

    const json = JSON.parse(result.stdout)
    expect(json.data.oauth.allowedGroups).toEqual(["admins"])
  })

  test("should remove all OAuth with --remove", async () => {
    await deploySite("remove-all-site")

    // Set OAuth first
    await runCli(["--json", "sites", "auth", "remove-all-site", "--allowed-emails", "user@example.com"])

    // Remove all OAuth
    const result = await runCli(["--json", "sites", "auth", "remove-all-site", "--remove"])
    expect(result.exitCode).toBe(0)

    const json = JSON.parse(result.stdout)
    expect(json.data.oauth).toBeNull()
  })

  test("should fail without any options", async () => {
    await deploySite("no-options-site")

    const result = await runCli(["sites", "auth", "no-options-site"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("specify at least one")
  })

  test("should handle case-insensitive emails", async () => {
    await deploySite("case-site")

    const result = await runCli(["--json", "sites", "auth", "case-site", "--allowed-emails", "USER@EXAMPLE.COM"])
    expect(result.exitCode).toBe(0)

    const json = JSON.parse(result.stdout)
    expect(json.data.oauth.allowedEmails).toEqual(["user@example.com"])
  })

  test("should handle multiple emails in comma-separated list", async () => {
    await deploySite("multi-email-site")

    const result = await runCli(["--json", "sites", "auth", "multi-email-site", "--allowed-emails", "a@example.com,b@example.com,c@example.com"])
    expect(result.exitCode).toBe(0)

    const json = JSON.parse(result.stdout)
    expect(json.data.oauth.allowedEmails).toHaveLength(3)
  })
})
