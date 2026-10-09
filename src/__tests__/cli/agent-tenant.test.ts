import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { spawn } from "bun"

// `siteio agent tenant` edits <dataDir>/agent-config.json on the box.
describe("CLI: agent tenant", () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-agent-tenant-"))
    writeFileSync(join(dataDir, "agent-config.json"), JSON.stringify({ apiKey: "god", domain: "example.com" }))
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  async function runCli(args: string[]) {
    const proc = spawn({
      cmd: ["bun", "run", "src/cli.ts", ...args],
      cwd: process.cwd(),
      env: { ...process.env, SITEIO_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { stdout, stderr, exitCode: await proc.exited }
  }
  const config = () => JSON.parse(readFileSync(join(dataDir, "agent-config.json"), "utf-8"))

  test("add creates a tenant with its own key and prints a login token", async () => {
    const res = await runCli(["--json", "agent", "tenant", "add", "Friend.com"])
    expect(res.exitCode).toBe(0)
    const out = JSON.parse(res.stdout)
    expect(out.domain).toBe("friend.com")
    expect(out.apiUrl).toBe("https://api.friend.com")
    expect(out.apiKey).toMatch(/^[0-9a-f]{64}$/)
    expect(out.apiKey).not.toBe("god")
    expect(config().tenants).toHaveLength(1)
  })

  test("add refuses overlaps and leaves the config unchanged", async () => {
    await runCli(["agent", "tenant", "add", "friend.com"])
    for (const d of ["friend.com", "example.com", "blog.example.com", "x.friend.com", "not a domain"]) {
      const res = await runCli(["agent", "tenant", "add", d])
      expect(res.exitCode).toBe(1)
    }
    expect(config().tenants).toHaveLength(1)
  })

  test("add refuses a domain already used as a custom domain", async () => {
    mkdirSync(join(dataDir, "pockets"), { recursive: true })
    writeFileSync(join(dataDir, "pockets", "shop.json"), JSON.stringify({ name: "shop", domains: ["www.friend.com"] }))
    const res = await runCli(["agent", "tenant", "add", "friend.com"])
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("shop")
    expect(config().tenants).toBeUndefined()
  })

  test("remove refuses while the tenant still has sites", async () => {
    await runCli(["agent", "tenant", "add", "friend.com"])
    mkdirSync(join(dataDir, "pockets"), { recursive: true })
    writeFileSync(join(dataDir, "pockets", "blog--friend-com.json"), JSON.stringify({ name: "blog--friend-com", domains: [] }))
    const res = await runCli(["agent", "tenant", "remove", "friend.com"])
    expect(res.exitCode).toBe(1)
    expect(config().tenants).toHaveLength(1)
  })

  test("remove deletes an empty tenant; removing an unknown one fails", async () => {
    await runCli(["agent", "tenant", "add", "friend.com"])
    expect((await runCli(["agent", "tenant", "remove", "friend.com"])).exitCode).toBe(0)
    expect(config().tenants).toEqual([])
    expect((await runCli(["agent", "tenant", "remove", "friend.com"])).exitCode).toBe(1)
  })

  test("add --apps lets the tenant run apps; a plain add does not", async () => {
    const plain = await runCli(["--json", "agent", "tenant", "add", "friend.com"])
    expect(JSON.parse(plain.stdout).apps).toBe(false)
    const res = await runCli(["--json", "agent", "tenant", "add", "vaults.net", "--apps"])
    expect(res.exitCode).toBe(0)
    expect(JSON.parse(res.stdout).apps).toBe(true)
    const tenants = config().tenants as { domain: string; apps?: boolean }[]
    expect(tenants.find((t) => t.domain === "vaults.net")!.apps).toBe(true)
    expect(tenants.find((t) => t.domain === "friend.com")!.apps).toBeUndefined()
  })

  test("remove refuses while the tenant still has apps", async () => {
    await runCli(["agent", "tenant", "add", "vaults.net", "--apps"])
    mkdirSync(join(dataDir, "apps"), { recursive: true })
    writeFileSync(join(dataDir, "apps", "vault--vaults-net.json"), JSON.stringify({ name: "vault--vaults-net", domains: [] }))
    const res = await runCli(["agent", "tenant", "remove", "vaults.net"])
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("vault--vaults-net")
    expect(config().tenants).toHaveLength(1)
  })

  test("list and config list never print tenant keys", async () => {
    const added = JSON.parse((await runCli(["--json", "agent", "tenant", "add", "friend.com"])).stdout)
    const list = await runCli(["agent", "tenant", "list"])
    expect(list.stdout + list.stderr).toContain("friend.com")
    expect(list.stdout + list.stderr).not.toContain(added.apiKey)
    const cfg = await runCli(["--json", "agent", "config", "list"])
    expect(cfg.stdout).not.toContain(added.apiKey)
  })

  test("add refuses when an existing site key already ends with the tenant slug", async () => {
    mkdirSync(join(dataDir, "pockets"), { recursive: true })
    writeFileSync(join(dataDir, "pockets", "blog--friend-com.json"), JSON.stringify({ name: "blog--friend-com", domains: [] }))
    const res = await runCli(["agent", "tenant", "add", "friend.com"])
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("blog--friend-com")
    expect(config().tenants).toBeUndefined()
  })
})
