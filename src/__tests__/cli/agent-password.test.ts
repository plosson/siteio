import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { spawn } from "bun"
import { UserStore } from "../../lib/agent/user-store.ts"

describe("CLI: agent password", () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-agent-password-"))
    writeFileSync(join(dataDir, "agent-config.json"), JSON.stringify({ apiKey: "god", domain: "example.com" }))
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  async function runCli(args: string[]) {
    const proc = spawn({
      cmd: ["bun", "run", "src/cli.ts", ...args],
      cwd: process.cwd(),
      env: { ...process.env, SITEIO_DATA_DIR: dataDir },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { stdout, stderr, exitCode: await proc.exited }
  }

  test("creates the admin with a generated password, printed once", async () => {
    const res = await runCli(["--json", "agent", "password"])
    expect(res.exitCode).toBe(0)
    const out = JSON.parse(res.stdout)
    expect(out.username).toBe("admin")
    expect(out.password).toHaveLength(24)
    expect(await new UserStore(dataDir).verifyPassword("admin", out.password)).not.toBeNull()
  })

  test("a second run resets it; the old password stops working", async () => {
    const first = JSON.parse((await runCli(["--json", "agent", "password"])).stdout).password
    const second = JSON.parse((await runCli(["--json", "agent", "password"])).stdout).password
    const store = new UserStore(dataDir)
    expect(await store.verifyPassword("admin", first)).toBeNull()
    expect(await store.verifyPassword("admin", second)).not.toBeNull()
  })

  test("--password sets the given one; a short one is refused", async () => {
    expect((await runCli(["agent", "password", "--password", "my own password"])).exitCode).toBe(0)
    expect(await new UserStore(dataDir).verifyPassword("admin", "my own password")).not.toBeNull()
    expect((await runCli(["agent", "password", "--password", "short"])).exitCode).toBe(1)
  })

  test("refuses when a non-admin user is named admin", async () => {
    mkdirSync(join(dataDir, "users"), { recursive: true })
    writeFileSync(join(dataDir, "users", "admin.json"), JSON.stringify({ username: "admin", role: "member", passwordHash: "", createdAt: "", keys: [] }))
    expect((await runCli(["agent", "password"])).exitCode).toBe(1)
  })
})
