import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawn } from "bun"

/**
 * After `apps set` / `apps unset` on a running app, the CLI tells the user how
 * to apply the change. `apps restart` is a plain `docker restart`, which keeps
 * the container's old env, domains, volumes and port — only `apps deploy`
 * recreates it. Pointing at restart silently leaves the change unapplied.
 */

let server: ReturnType<typeof Bun.serve> | null = null
let homeDir = ""

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      Response.json({
        success: true,
        data: { name: "testapp", status: "running", env: {}, secretKeys: [], domains: [], volumes: [] },
      }),
  })
  homeDir = mkdtempSync(join(tmpdir(), "siteio-apps-config-hint-"))
  const cfgDir = join(homeDir, ".config", "siteio")
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(
    join(cfgDir, "config.json"),
    JSON.stringify({ current: "test", servers: { test: { apiUrl: `http://127.0.0.1:${server.port}`, apiKey: "k" } } })
  )
})

afterAll(() => {
  server?.stop()
  if (homeDir) rmSync(homeDir, { recursive: true, force: true })
})

async function runCli(args: string[]): Promise<string> {
  const proc = spawn({
    cmd: ["bun", "run", "src/cli.ts", ...args],
    cwd: process.cwd(),
    env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: join(homeDir, ".config") },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect(await proc.exited).toBe(0)
  return stdout + stderr
}

describe("CLI: apply-config hint", () => {
  for (const args of [
    ["apps", "set", "testapp", "-e", "FOO=bar"],
    ["apps", "unset", "testapp", "-e", "FOO"],
  ]) {
    test(`${args.slice(0, 2).join(" ")} on a running app points at deploy, never restart`, async () => {
      const out = await runCli(args)
      expect(out).toContain("siteio apps deploy testapp")
      expect(out).not.toContain("siteio apps restart")
    })
  }
})
