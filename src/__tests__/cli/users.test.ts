import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { spawn } from "bun"
import { AgentServer } from "../../lib/agent/server.ts"
import { UserStore } from "../../lib/agent/user-store.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig } from "../../types.ts"

const PORT = 4583

describe("CLI: siteio users", () => {
  let server: AgentServer
  let dataDir: string
  let users: UserStore
  const homes: Record<string, string> = {}

  // One HOME per identity, each logged in to the test agent with its own key.
  function homeFor(name: string, apiKey: string): string {
    const home = mkdtempSync(join(tmpdir(), `siteio-users-cli-${name}-`))
    mkdirSync(join(home, ".config", "siteio"), { recursive: true })
    writeFileSync(
      join(home, ".config", "siteio", "config.json"),
      JSON.stringify({ current: "test", servers: { test: { apiUrl: `http://localhost:${PORT}`, apiKey } } })
    )
    return home
  }

  async function runCli(as: string, args: string[]) {
    const proc = spawn({
      cmd: ["bun", "run", "src/cli.ts", ...args],
      cwd: process.cwd(),
      env: { ...process.env, HOME: homes[as]!, XDG_CONFIG_HOME: join(homes[as]!, ".config") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { stdout, stderr, exitCode: await proc.exited }
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-users-cli-data-"))
    users = new UserStore(dataDir)
    await users.setAdminPassword("admin password")
    await users.create({ username: "mia", role: "member", password: "member password" })
    homes.admin = homeFor("admin", users.addKey("admin", "machine", "t").secret)
    homes.mia = homeFor("mia", users.addKey("mia", "machine", "t").secret)
    homes.god = homeFor("god", "god-key")
    const config: AgentConfig = {
      apiKey: "god-key", dataDir, domain: "example.com", port: PORT,
      maxUploadSize: 50 * 1024 * 1024, httpPort: 80, httpsPort: 443, skipTraefik: true,
    }
    server = new AgentServer(config, new FakeRuntime())
    await server.start()
  })

  afterAll(() => {
    server.stop()
    rmSync(dataDir, { recursive: true, force: true })
    for (const home of Object.values(homes)) rmSync(home, { recursive: true, force: true })
  })

  test("the admin adds a member: the password is printed once and works", async () => {
    const res = await runCli("admin", ["--json", "users", "add", "zed"])
    expect(res.exitCode).toBe(0)
    const { data } = JSON.parse(res.stdout)
    expect(data.user).toMatchObject({ username: "zed", role: "member", tenant: null })
    expect(await users.verifyPassword("zed", data.password)).not.toBeNull()
  })

  test("list works for the admin and the god key", async () => {
    for (const as of ["admin", "god"]) {
      const res = await runCli(as, ["--json", "users", "list"])
      expect(res.exitCode).toBe(0)
      expect(JSON.parse(res.stdout).data.map((u: { username: string }) => u.username)).toContain("mia")
    }
  })

  test("a member can't list or add users", async () => {
    expect((await runCli("mia", ["users", "list"])).exitCode).toBe(1)
    expect((await runCli("mia", ["users", "add", "yan"])).exitCode).toBe(1)
    expect(users.get("yan")).toBeNull()
  })

  test("a bad role or name fails with the agent's message", async () => {
    const res = await runCli("admin", ["users", "add", "Bad Name"])
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("lowercase")
    expect((await runCli("admin", ["users", "add", "yan", "--role", "admin"])).exitCode).toBe(1)
  })

  test("reset-password and remove", async () => {
    await users.create({ username: "rex", role: "member", password: "rex password" })
    const reset = JSON.parse((await runCli("admin", ["--json", "users", "reset-password", "rex"])).stdout)
    expect(await users.verifyPassword("rex", reset.data.password)).not.toBeNull()
    expect((await runCli("admin", ["users", "remove", "rex"])).exitCode).toBe(0)
    expect(users.get("rex")).toBeNull()
    expect((await runCli("admin", ["users", "remove", "rex"])).exitCode).toBe(1)
  })

  test("keys lists your own keys; revoke-key revokes one", async () => {
    const { key } = users.addKey("mia", "machine", "old laptop")
    const list = JSON.parse((await runCli("mia", ["--json", "users", "keys"])).stdout).data
    expect(list.map((k: { name: string }) => k.name)).toContain("old laptop")
    expect((await runCli("mia", ["users", "revoke-key", key.id])).exitCode).toBe(0)
    expect(users.get("mia")!.keys.some((k) => k.id === key.id)).toBe(false)
  })
})
