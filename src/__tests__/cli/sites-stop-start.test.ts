import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawn } from "bun"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig } from "../../types.ts"

/** `siteio sites stop|start|upgrade --all` against a real AgentServer (fake runtime). */

let http: ReturnType<typeof Bun.serve> | null = null
let agent: AgentServer
let dataDir = ""
let homeDir = ""

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "siteio-stopstart-data-"))
  const config: AgentConfig = {
    apiKey: "k", dataDir, domain: "example.com",
    maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
  }
  agent = new AgentServer(config, new FakeRuntime())
  http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => agent.handleRequestForTest(req) })
  homeDir = mkdtempSync(join(tmpdir(), "siteio-stopstart-home-"))
  const cfgDir = join(homeDir, ".config", "siteio")
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(
    join(cfgDir, "config.json"),
    JSON.stringify({ current: "test", servers: { test: { apiUrl: `http://127.0.0.1:${http.port}`, apiKey: "k", domain: "example.com" } } })
  )
})

afterEach(() => {
  http?.stop(true)
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
})

async function runCli(args: string[]) {
  const proc = spawn({
    cmd: ["bun", "run", join(process.cwd(), "src/cli.ts"), ...args],
    cwd: homeDir,
    env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: join(homeDir, ".config") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { stdout, stderr, exitCode: await proc.exited }
}

async function deploySite(name: string) {
  const res = await agent.handleRequestForTest(new Request(`http://x/sites/${name}`, {
    method: "POST",
    headers: { "X-API-Key": "k", "Content-Type": "application/zip" },
    body: zipSync({ "public/index.html": new TextEncoder().encode(name) }),
  }))
  expect(res.status).toBe(200)
}

describe("CLI: sites stop / start / upgrade --all", () => {
  test("stop then start round-trips and --json carries the site", async () => {
    await deploySite("blog")
    const stop = await runCli(["--json", "sites", "stop", "blog"])
    expect(stop.exitCode).toBe(0)
    expect(JSON.parse(stop.stdout).data.status).toBe("stopped")
    const start = await runCli(["--json", "sites", "start", "blog"])
    expect(start.exitCode).toBe(0)
    expect(JSON.parse(start.stdout).data.status).toBe("running")
  })

  test("stopping an unknown site fails non-zero", async () => {
    const r = await runCli(["sites", "stop", "ghost"])
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain("not found")
  })

  test("a restarted site is no longer skipped by upgrade --all", async () => {
    await deploySite("a")
    expect((await runCli(["sites", "stop", "a"])).exitCode).toBe(0)
    expect((await runCli(["sites", "start", "a"])).exitCode).toBe(0)
    const r = await runCli(["--json", "sites", "upgrade", "--all", "--yes"])
    const parsed = JSON.parse(r.stdout)
    expect(parsed.skipped).toEqual([])
    expect(parsed.data.map((o: { name: string }) => o.name)).toEqual(["a"])
  })

  test("upgrade --all skips stopped sites and lists them in JSON `skipped`", async () => {
    await deploySite("a")
    await deploySite("b")
    expect((await runCli(["sites", "stop", "b"])).exitCode).toBe(0)
    const r = await runCli(["--json", "sites", "upgrade", "--all", "--yes"])
    const parsed = JSON.parse(r.stdout)
    expect(parsed.skipped).toEqual(["b"])
    expect(parsed.data.map((o: { name: string }) => o.name)).toEqual(["a"])
    expect(r.stderr).toContain("b: stopped, skipped")
  })

  test("upgrade --all with every site stopped errors clearly", async () => {
    await deploySite("a")
    expect((await runCli(["sites", "stop", "a"])).exitCode).toBe(0)
    const r = await runCli(["sites", "upgrade", "--all", "--yes"])
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain("Every site is stopped")
  })
})
