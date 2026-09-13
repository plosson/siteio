import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawn } from "bun"

/**
 * CLI flag tests for the secret-setting surface of `siteio apps set`.
 *
 * What matters here is the wire: a secret must travel in `secrets` (which the
 * agent encrypts) and never in `env` (which the agent stores and echoes back
 * in the clear), and the CLI's own output must not print the value it just
 * sent. `--secret-file` / `--secret-stdin` exist so the value never reaches
 * shell history or the process list, so they are checked end to end.
 */

const TEST_API_KEY = "secret-flag-test-key"
const SECRET = "not-a-secret-probe-value"

interface RecordedRequest {
  method: string
  path: string
  bodyJson: Record<string, unknown> | null
}

let server: ReturnType<typeof Bun.serve> | null = null
let port = 0
let homeDir = ""
let recorded: RecordedRequest[] = []

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      let bodyJson: Record<string, unknown> | null = null
      if ((req.headers.get("content-type") ?? "").includes("application/json")) {
        try {
          bodyJson = (await req.json()) as Record<string, unknown>
        } catch {
          bodyJson = null
        }
      }
      recorded.push({ method: req.method, path: url.pathname, bodyJson })

      // Minimal App the CLI can render: the agent returns key names only.
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            name: "testapp",
            status: "stopped",
            env: {},
            secretKeys: ["VAULT_PASSPHRASE"],
            domains: [],
            volumes: [],
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

  homeDir = mkdtempSync(join(tmpdir(), "siteio-apps-set-secret-flags-"))
  const cfgDir = join(homeDir, ".config", "siteio")
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(
    join(cfgDir, "config.json"),
    JSON.stringify({
      current: "test",
      servers: {
        test: { apiUrl: `http://127.0.0.1:${port}`, apiKey: TEST_API_KEY },
      },
    })
  )
})

afterAll(() => {
  server?.stop()
  if (homeDir) rmSync(homeDir, { recursive: true, force: true })
})

async function runCli(
  args: string[],
  stdin?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  recorded = []
  const proc = spawn({
    cmd: ["bun", "run", "src/cli.ts", ...args],
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: join(homeDir, ".config"),
    },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
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

function patchBody(): Record<string, unknown> {
  const patch = recorded.find((r) => r.method === "PATCH" && r.path === "/apps/testapp")
  if (!patch) throw new Error("expected a PATCH /apps/testapp")
  return patch.bodyJson ?? {}
}

describe("CLI: apps set secret flags", () => {
  test("--secret sends the value in `secrets`, never in `env`", async () => {
    const result = await runCli(["apps", "set", "testapp", "--secret", `VAULT_PASSPHRASE=${SECRET}`])
    expect(result.exitCode).toBe(0)

    const body = patchBody()
    expect(body.secrets).toEqual({ VAULT_PASSPHRASE: SECRET })
    expect(body.env).toBeUndefined()
  })

  test("--secret does not print the value back", async () => {
    const result = await runCli(["apps", "set", "testapp", "--secret", `VAULT_PASSPHRASE=${SECRET}`])
    expect(result.stdout + result.stderr).not.toContain(SECRET)
    expect(result.stdout).toContain("VAULT_PASSPHRASE")
  })

  test("-e still sends plain env vars", async () => {
    const result = await runCli(["apps", "set", "testapp", "-e", "NODE_ENV=production"])
    expect(result.exitCode).toBe(0)

    const body = patchBody()
    expect(body.env).toEqual({ NODE_ENV: "production" })
    expect(body.secrets).toBeUndefined()
  })

  test("--secret-file reads the value from a file and drops its trailing newline", async () => {
    const secretPath = join(homeDir, "passphrase.txt")
    writeFileSync(secretPath, `${SECRET}\n`)

    const result = await runCli(["apps", "set", "testapp", "--secret-file", `VAULT_PASSPHRASE=${secretPath}`])
    expect(result.exitCode).toBe(0)
    expect(patchBody().secrets).toEqual({ VAULT_PASSPHRASE: SECRET })
    expect(result.stdout + result.stderr).not.toContain(SECRET)
  })

  test("--secret-file fails clearly on a missing file", async () => {
    const result = await runCli(["apps", "set", "testapp", "--secret-file", `K=${join(homeDir, "nope.txt")}`])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Secret file not found")
  })

  test("--secret-stdin reads the value from stdin", async () => {
    const result = await runCli(["apps", "set", "testapp", "--secret-stdin", "VAULT_PASSPHRASE"], `${SECRET}\n`)
    expect(result.exitCode).toBe(0)
    expect(patchBody().secrets).toEqual({ VAULT_PASSPHRASE: SECRET })
    expect(result.stdout + result.stderr).not.toContain(SECRET)
  })

  test("apps info masks secret keys and has no way to reveal them", async () => {
    const result = await runCli(["apps", "info", "testapp"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("VAULT_PASSPHRASE=••••••••")
    expect(result.stdout).toContain("(secret)")

    // There is deliberately no --reveal: a secret is write-only once set.
    const help = await runCli(["apps", "info", "--help"])
    expect(help.stdout + help.stderr).not.toContain("--reveal")
  })

  test("rejects a key given as both --env and --secret", async () => {
    const result = await runCli([
      "apps",
      "set",
      "testapp",
      "-e",
      `VAULT_PASSPHRASE=${SECRET}`,
      "--secret",
      `VAULT_PASSPHRASE=${SECRET}`,
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Pick one")
    expect(recorded.some((r) => r.method === "PATCH")).toBe(false)
  })
})
