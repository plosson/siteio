import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawn } from "bun"

/**
 * CLI flag tests for `siteio sites set|unset`, against a mock agent: a secret
 * must travel in `secrets`, never in `env`, and the CLI must not print it.
 */

const TEST_API_KEY = "secret-flag-test-key"

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

      // A SiteInfo as the agent returns it: secret key names only.
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            name: "blog", url: "https://blog.test", adminUrl: "https://blog.test/_/", domains: [],
            status: "running", pocketbaseVersion: "0.30.0", size: 1, createdAt: "2026-10-08T00:00:00.000Z",
            env: { A: "1" }, secretKeys: ["STRIPE_SECRET_KEY"],
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

  homeDir = mkdtempSync(join(tmpdir(), "siteio-sites-env-flags-"))
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
  const patch = recorded.find((r) => r.method === "PATCH" && r.path === "/sites/blog/env")
  if (!patch) throw new Error("expected a PATCH /sites/blog/env")
  return patch.bodyJson ?? {}
}

const SECRET = "sk_live_cli_probe"

describe("CLI: sites set / unset", () => {
  test("--secret travels in `secrets`, never in `env`, and is not printed", async () => {
    const r = await runCli(["sites", "set", "blog", "--secret", `STRIPE_SECRET_KEY=${SECRET}`])
    expect(r.exitCode).toBe(0)
    expect(patchBody()).toEqual({ secrets: { STRIPE_SECRET_KEY: SECRET } })
    expect(r.stdout + r.stderr).not.toContain(SECRET)
    expect(r.stderr).toContain("STRIPE_SECRET_KEY")
  })

  test("-e sends plain vars; a value containing '=' is kept whole", async () => {
    await runCli(["sites", "set", "blog", "-e", "A=1", "-e", "URL=https://x?a=b"])
    expect(patchBody()).toEqual({ env: { A: "1", URL: "https://x?a=b" } })
  })

  test("-e with a bare path bulk-loads an env file", async () => {
    const file = join(homeDir, "site.env")
    writeFileSync(file, "# comment\nA=1\nB=\"two\"\n")
    await runCli(["sites", "set", "blog", "-e", file])
    expect(patchBody()).toEqual({ env: { A: "1", B: "two" } })
  })

  test("--secret-file and --secret-stdin read the value and drop one trailing newline", async () => {
    const file = join(homeDir, "secret.txt")
    writeFileSync(file, `${SECRET}\n`)
    await runCli(["sites", "set", "blog", "--secret-file", `S=${file}`])
    expect(patchBody()).toEqual({ secrets: { S: SECRET } })
    await runCli(["sites", "set", "blog", "--secret-stdin", "S"], `${SECRET}\n`)
    expect(patchBody()).toEqual({ secrets: { S: SECRET } })
  })

  test("refuses bad input before calling the agent", async () => {
    for (const args of [
      ["-e", "=1"], ["-e", "no-equals-and-no-file"], ["--secret-file", "S=/nope/missing"],
      ["-e", "S=1", "--secret", "S=2"], [],
    ]) {
      const r = await runCli(["sites", "set", "blog", ...args])
      expect(r.exitCode).not.toBe(0)
      expect(recorded.some((q) => q.method === "PATCH")).toBe(false)
    }
    const empty = await runCli(["sites", "set", "blog", "--secret-stdin", "S"], "")
    expect(empty.exitCode).not.toBe(0)
  })

  test("unset sends unsetEnv and needs at least one key", async () => {
    await runCli(["sites", "unset", "blog", "-e", "A", "-e", "S"])
    expect(patchBody()).toEqual({ unsetEnv: ["A", "S"] })
    const none = await runCli(["sites", "unset", "blog"])
    expect(none.exitCode).not.toBe(0)
  })

  test("--json prints the agent's response on stdout", async () => {
    const r = await runCli(["--json", "sites", "set", "blog", "-e", "A=1"])
    expect(JSON.parse(r.stdout).data.secretKeys).toEqual(["STRIPE_SECRET_KEY"])
  })

  test("sites info masks secrets", async () => {
    const r = await runCli(["sites", "info", "blog"])
    expect(r.stderr).toContain("A=1")
    expect(r.stderr).toContain("STRIPE_SECRET_KEY=••••••••")
  })
})
