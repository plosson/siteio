import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { hostname, tmpdir, userInfo } from "os"
import { join } from "path"
import { spawn } from "bun"

/**
 * Every CLI call to the agent says who is calling (X-Siteio-User): the
 * configured username, else user@host. Nothing may slip out unnamed.
 */

let server: ReturnType<typeof Bun.serve> | null = null
let homeDir = ""
let seen: { path: string; user: string | null; legacy: string | null }[] = []

function writeConfig(extra: Record<string, unknown>): void {
  const cfgDir = join(homeDir, ".config", "siteio")
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(
    join(cfgDir, "config.json"),
    JSON.stringify({ current: "test", servers: { test: { apiUrl: `http://127.0.0.1:${server!.port}`, apiKey: "k" } }, ...extra })
  )
}

beforeEach(() => {
  seen = []
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      seen.push({ path: new URL(req.url).pathname, user: req.headers.get("X-Siteio-User"), legacy: req.headers.get("X-Deployed-By") })
      const path = new URL(req.url).pathname
      if (path === "/sites") return Response.json({ success: true, data: [] })
      return Response.json({ success: true, data: { name: "testapp", status: "running", env: {}, secretKeys: [], domains: [], volumes: [] } })
    },
  })
  homeDir = mkdtempSync(join(tmpdir(), "siteio-user-header-"))
})

afterEach(() => {
  server?.stop()
  rmSync(homeDir, { recursive: true, force: true })
})

async function runCli(args: string[]): Promise<void> {
  const proc = spawn({
    cmd: ["bun", "run", "src/cli.ts", ...args],
    cwd: process.cwd(),
    env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: join(homeDir, ".config") },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect(await proc.exited, stderr).toBe(0)
}

const machineUser = `${userInfo().username}@${hostname()}`

describe("CLI: X-Siteio-User", () => {
  test("with no username configured, falls back to user@host instead of sending nothing", async () => {
    writeConfig({})
    await runCli(["--json", "sites", "list"])
    expect(seen.length).toBeGreaterThan(0)
    for (const r of seen) expect(decodeURIComponent(r.user!)).toBe(machineUser)
  })

  test("a whitespace-only username is treated as unset, not sent blank", async () => {
    writeConfig({ username: "   " })
    await runCli(["--json", "sites", "list"])
    for (const r of seen) expect(decodeURIComponent(r.user!)).toBe(machineUser)
  })

  test("mutating calls carry the configured username, and the legacy header is gone", async () => {
    writeConfig({ username: "ada" })
    await runCli(["--json", "apps", "restart", "testapp"])
    expect(seen.some((r) => r.path.endsWith("/restart"))).toBe(true)
    for (const r of seen) {
      expect(decodeURIComponent(r.user!)).toBe("ada")
      expect(r.legacy).toBeNull()
    }
  })

  test("a non-ASCII username survives the trip instead of breaking the request", async () => {
    writeConfig({ username: "Zoë 张" })
    await runCli(["--json", "sites", "list"])
    expect(seen.length).toBeGreaterThan(0)
    for (const r of seen) expect(decodeURIComponent(r.user!)).toBe("Zoë 张")
  })

  test("raw health checks outside the client (status) are named too", async () => {
    writeConfig({ username: "ada" })
    await runCli(["status"])
    const health = seen.filter((r) => r.path === "/health")
    expect(health.length).toBe(1)
    expect(decodeURIComponent(health[0]!.user!)).toBe("ada")
  })
})
