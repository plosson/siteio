import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { spawn } from "bun"
import { AgentServer } from "../lib/agent/server.ts"
import type { AgentConfig } from "../types.ts"

const TEST_PORT = 4568
const TEST_API_KEY = "integration-test-key"
const TEST_DOMAIN = "integration.local"

describe("CLI Integration", () => {
  let server: AgentServer
  let dataDir: string
  let testSiteDir: string
  let configDir: string

  beforeAll(async () => {
    // Create temp directories
    dataDir = mkdtempSync(join(tmpdir(), "siteio-int-data-"))
    testSiteDir = mkdtempSync(join(tmpdir(), "siteio-int-site-"))
    configDir = mkdtempSync(join(tmpdir(), "siteio-int-config-"))

    // Create test site
    writeFileSync(join(testSiteDir, "index.html"), "<html><body><h1>Integration Test</h1></body></html>")
    writeFileSync(join(testSiteDir, "page.html"), "<html><body><h1>Page</h1></body></html>")

    // Create config file
    const configFile = join(configDir, "config.json")
    writeFileSync(
      configFile,
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
      maxUploadSize: 50 * 1024 * 1024,
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
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true })
    if (existsSync(testSiteDir)) rmSync(testSiteDir, { recursive: true })
    if (existsSync(configDir)) rmSync(configDir, { recursive: true })
  })

  async function runCli(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = spawn({
      cmd: ["bun", "run", "src/cli.ts", ...args],
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: configDir, // Override HOME so config is read from our test dir
        XDG_CONFIG_HOME: configDir, // Also set XDG
        ...env,
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

  test("should show help", async () => {
    const result = await runCli(["--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Deploy static sites with ease")
    expect(result.stdout).toContain("login")
    expect(result.stdout).toContain("sites")
    expect(result.stdout).toContain("agent")
  })

  test("should show sites help", async () => {
    const result = await runCli(["sites", "--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("deploy")
    expect(result.stdout).toContain("list")
    expect(result.stdout).toContain("undeploy")
  })

  test("should list empty sites via CLI", async () => {
    // Create config in the right location for this test
    const siteioConfigDir = join(configDir, ".config", "siteio")
    const { mkdirSync } = await import("fs")
    mkdirSync(siteioConfigDir, { recursive: true })
    writeFileSync(
      join(siteioConfigDir, "config.json"),
      JSON.stringify({
        apiUrl: `http://localhost:${TEST_PORT}`,
        apiKey: TEST_API_KEY,
      })
    )

    const result = await runCli(["--json", "sites", "list"])
    expect(result.exitCode).toBe(0)

    // Should have JSON output in stdout
    const jsonOutput = JSON.parse(result.stdout)
    expect(jsonOutput.success).toBe(true)
  })

  test("should deploy site via CLI", async () => {
    const result = await runCli(["--json", "sites", "deploy", testSiteDir, "--subdomain", "inttest"])

    expect(result.exitCode).toBe(0)

    // Verify JSON output
    const jsonOutput = JSON.parse(result.stdout)
    expect(jsonOutput.success).toBe(true)
    expect(jsonOutput.data.subdomain).toBe("inttest")
  })

  test("should list deployed site via CLI", async () => {
    const result = await runCli(["--json", "sites", "list"])
    expect(result.exitCode).toBe(0)

    const jsonOutput = JSON.parse(result.stdout)
    expect(jsonOutput.data.length).toBe(1)
    expect(jsonOutput.data[0].subdomain).toBe("inttest")
  })

  test("should undeploy site via CLI", async () => {
    const result = await runCli(["sites", "undeploy", "inttest"])
    expect(result.exitCode).toBe(0)

    // Verify it's gone
    const listResult = await runCli(["--json", "sites", "list"])
    const jsonOutput = JSON.parse(listResult.stdout)
    expect(jsonOutput.data.length).toBe(0)
  })

  test("should deploy using folder name as subdomain", async () => {
    // Create a folder with a specific name
    const namedDir = join(tmpdir(), "my-cool-site")
    if (existsSync(namedDir)) rmSync(namedDir, { recursive: true })
    const { mkdirSync } = await import("fs")
    mkdirSync(namedDir)
    writeFileSync(join(namedDir, "index.html"), "<html><body>Auto-named</body></html>")

    try {
      const result = await runCli(["--json", "sites", "deploy", namedDir])
      expect(result.exitCode).toBe(0)

      const jsonOutput = JSON.parse(result.stdout)
      expect(jsonOutput.data.subdomain).toBe("my-cool-site")

      // Cleanup
      await runCli(["sites", "undeploy", "my-cool-site"])
    } finally {
      rmSync(namedDir, { recursive: true })
    }
  })
})
