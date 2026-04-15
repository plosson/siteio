import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawn } from "bun"

/**
 * CLI flag-propagation tests for `siteio apps deploy`.
 *
 * Regression: Commander's boolean-negation convention sets
 * `options.cache = false` when `--no-cache` is passed — NOT
 * `options.noCache = true`. The action handler has to translate. If it
 * forgets, the flag is silently dropped on the wire (no `?noCache=true`
 * query param reaches the agent), docker keeps its layer cache, and
 * users get stale binaries without any error.
 *
 * This test pins the translation by spawning the CLI against a minimal
 * mock agent and asserting the actual query string / body it receives.
 */

const TEST_API_KEY = "flag-test-key"

interface RecordedRequest {
  method: string
  path: string
  search: string
  bodyJson: Record<string, unknown> | null
}

let server: ReturnType<typeof Bun.serve> | null = null
let port = 0
let homeDir = ""
let recorded: RecordedRequest[] = []

function resetRecorded(): void {
  recorded = []
}

beforeAll(async () => {
  // Pick an ephemeral port.
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      let bodyJson: Record<string, unknown> | null = null
      const ct = req.headers.get("content-type") ?? ""
      if (ct.includes("application/json")) {
        try {
          bodyJson = (await req.json()) as Record<string, unknown>
        } catch {
          bodyJson = null
        }
      }
      recorded.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        bodyJson,
      })

      // Canned response that matches what the CLI expects from a
      // successful deploy (minimal AppInfo).
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            name: "testapp",
            status: "running",
            domains: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    },
  })
  if (server.port == null) {
    throw new Error("Bun.serve did not assign a port")
  }
  port = server.port

  homeDir = mkdtempSync(join(tmpdir(), "siteio-apps-deploy-flags-"))
  const cfgDir = join(homeDir, ".config", "siteio")
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(
    join(cfgDir, "config.json"),
    JSON.stringify({
      current: "test",
      servers: {
        test: {
          apiUrl: `http://127.0.0.1:${port}`,
          apiKey: TEST_API_KEY,
        },
      },
    })
  )
})

afterAll(() => {
  server?.stop()
  if (homeDir) rmSync(homeDir, { recursive: true, force: true })
})

async function runCli(args: string[]): Promise<{
  stdout: string
  stderr: string
  exitCode: number
}> {
  const proc = spawn({
    cmd: ["bun", "run", "src/cli.ts", ...args],
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: join(homeDir, ".config"),
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

describe("CLI: apps deploy --no-cache flag propagation", () => {
  test("without --no-cache: no noCache query param on the wire", async () => {
    resetRecorded()
    const result = await runCli(["apps", "deploy", "testapp"])
    expect(result.exitCode).toBe(0)

    const deploy = recorded.find(
      (r) => r.method === "POST" && r.path === "/apps/testapp/deploy"
    )
    if (!deploy) throw new Error("expected a POST /apps/testapp/deploy")
    expect(deploy.search).toBe("")
  })

  test("--no-cache: ?noCache=true query param reaches the agent", async () => {
    resetRecorded()
    const result = await runCli(["apps", "deploy", "testapp", "--no-cache"])
    expect(result.exitCode).toBe(0)

    const deploy = recorded.find(
      (r) => r.method === "POST" && r.path === "/apps/testapp/deploy"
    )
    if (!deploy) throw new Error("expected a POST /apps/testapp/deploy")
    // The literal contract with the agent: query must be `?noCache=true`.
    // If Commander's --no-cache convention isn't translated in the action
    // handler, this assertion fails (search will be "" instead).
    expect(deploy.search).toBe("?noCache=true")
  })

  test("-f <file>: sends Dockerfile content in JSON body (with --no-cache)", async () => {
    const dockerfilePath = join(homeDir, "probe.Dockerfile")
    const dockerfile = `FROM alpine:latest\nCMD ["echo","hello"]\n`
    writeFileSync(dockerfilePath, dockerfile)

    resetRecorded()
    const result = await runCli([
      "apps",
      "deploy",
      "testapp",
      "--no-cache",
      "-f",
      dockerfilePath,
    ])
    expect(result.exitCode).toBe(0)

    const deploy = recorded.find(
      (r) => r.method === "POST" && r.path === "/apps/testapp/deploy"
    )
    if (!deploy) throw new Error("expected a POST /apps/testapp/deploy")
    expect(deploy.search).toBe("?noCache=true")
    expect(deploy.bodyJson).toEqual({ dockerfileContent: dockerfile })
  })
})
