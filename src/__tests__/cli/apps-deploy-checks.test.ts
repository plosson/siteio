import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawn } from "bun"
import type { AppServiceStatus } from "../../types"

/**
 * Post-deploy checks of `siteio apps deploy`: the CLI watches the containers
 * through GET /apps/:name/status, then waits for the public URL. A mock agent
 * serves both, and also plays the "public URL" so no network is involved.
 */

let server: ReturnType<typeof Bun.serve> | null = null
let port = 0
let homeDir = ""
let paths: string[] = []

// Per-test knobs
let statusServices: AppServiceStatus[] | null = [] // null: agent without the status route
let publicResponse: { status: number; body: string } = { status: 200, body: "hello" }
let deployCompose = true

beforeEach(() => {
  paths = []
  statusServices = [{ service: "web", primary: true, state: "running" }]
  publicResponse = { status: 200, body: "hello" }
  deployCompose = true
})

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      paths.push(url.pathname + url.search)
      if (url.pathname === "/apps/testapp/deploy") {
        return json({
          success: true,
          data: {
            name: "testapp",
            status: "running",
            domains: [],
            url: `http://127.0.0.1:${port}/public`,
            ...(deployCompose && { compose: { source: "inline", primaryService: "web" } }),
          },
        })
      }
      if (url.pathname === "/apps/testapp/status") {
        if (statusServices === null) return json({ success: false, error: "Not found" }, 404)
        return json({ success: true, data: { name: "testapp", services: statusServices } })
      }
      if (url.pathname === "/apps/testapp/logs") {
        const service = url.searchParams.get("service") ?? "(none)"
        return json({ success: true, data: { name: "testapp", logs: `boom from ${service}\n`, lines: 15 } })
      }
      if (url.pathname === "/public") {
        return new Response(publicResponse.body, { status: publicResponse.status })
      }
      return json({ success: false, error: "Not found" }, 404)
    },
  })
  port = server.port!

  homeDir = mkdtempSync(join(tmpdir(), "siteio-apps-deploy-checks-"))
  const cfgDir = join(homeDir, ".config", "siteio")
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(
    join(cfgDir, "config.json"),
    JSON.stringify({ current: "test", servers: { test: { apiUrl: `http://127.0.0.1:${port}`, apiKey: "k" } } })
  )
})

afterAll(() => {
  server?.stop()
  if (homeDir) rmSync(homeDir, { recursive: true, force: true })
})

async function runCli(args: string[]) {
  const proc = spawn({
    cmd: ["bun", "run", ...args],
    cwd: homeDir, // keep .siteio/config.json out of the repo
    env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: join(homeDir, ".config") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { stdout, stderr, output: stdout + stderr, exitCode: await proc.exited }
}

const cli = join(process.cwd(), "src/cli.ts")
const deploy = (...extra: string[]) => runCli([cli, "apps", "deploy", "testapp", ...extra])

describe("CLI: apps deploy checks", () => {
  test("a crash-looping sidecar fails the deploy and shows its own logs", async () => {
    statusServices = [
      { service: "web", primary: true, state: "running" },
      { service: "redis", primary: false, state: "restarting", exitCode: 1 },
    ]
    const r = await deploy()
    expect(r.exitCode).toBe(1)
    expect(r.output).toContain("redis keeps restarting")
    expect(r.output).toContain("boom from redis")
    expect(r.output).toContain("is not working")
    expect(paths).toContain("/apps/testapp/logs?tail=15&service=redis")
    // The URL is not checked once a container failed
    expect(paths).not.toContain("/public")
  })

  test("container apps fetch logs without a service parameter", async () => {
    deployCompose = false
    statusServices = [{ service: "testapp", primary: true, state: "exited", exitCode: 137 }]
    const r = await deploy()
    expect(r.exitCode).toBe(1)
    expect(r.output).toContain("testapp exited (exit code 137)")
    expect(paths).toContain("/apps/testapp/logs?tail=15")
  })

  test("--json reports success false with the failing services on stdout", async () => {
    statusServices = [{ service: "web", primary: true, state: "missing" }]
    const r = await deploy("--json")
    expect(r.exitCode).toBe(1)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.success).toBe(false)
    expect(parsed.checks.services).toEqual([{ service: "web", problem: "has no container" }])
  })

  test("old agent without the status route: skips the container check, still checks the URL", async () => {
    statusServices = null
    const r = await deploy()
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain("agent is too old")
    expect(paths).toContain("/public")
  })

  test("Traefik 404 on the public URL fails the deploy after the timeout", async () => {
    statusServices = null // skip the 10s container window
    publicResponse = { status: 404, body: "404 page not found\n" }
    const r = await deploy("--wait-timeout", "0", "--json")
    expect(r.exitCode).toBe(1)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.checks.url.ok).toBe(false)
    expect(parsed.checks.url.error).toContain("no route")
  })

  test("rejects a non-numeric --wait-timeout before deploying", async () => {
    const r = await deploy("--wait-timeout", "soon")
    expect(r.exitCode).not.toBe(0)
    expect(r.output).toContain("--wait-timeout")
    expect(paths).not.toContain("/apps/testapp/deploy")
  })

  test("healthy app: watches the full window, then the URL answers", async () => {
    const r = await deploy("--json")
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.success).toBe(true)
    expect(parsed.checks).toEqual({ services: [], url: { url: `http://127.0.0.1:${port}/public`, ok: true, status: 200 } })
    expect(paths.filter((p) => p === "/apps/testapp/status").length).toBeGreaterThan(1)
  }, 30000)
})
