import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawn } from "bun"
import { removeAppPrompt } from "../../commands/apps/rm.ts"

/**
 * `apps rm` / `sites rm` pass their cleanup flags to the agent as query
 * parameters and print the warnings it returns about what was left behind.
 */

let server: ReturnType<typeof Bun.serve> | null = null
let homeDir = ""
let seen: string[] = []

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const url = new URL(req.url)
      seen.push(`${req.method} ${url.pathname}${url.search}`)
      return Response.json({
        success: true,
        data: { deleted: true, warnings: ["Docker resources still tied to siteio-testapp: networks siteio-testapp_data"] },
      })
    },
  })
  homeDir = mkdtempSync(join(tmpdir(), "siteio-apps-rm-"))
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

beforeEach(() => {
  seen = []
})

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
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
  return { stdout, stderr }
}

describe("CLI: apps rm / sites rm", () => {
  test("no flags sends a plain DELETE and prints the warnings on stderr", async () => {
    const { stderr } = await runCli(["apps", "rm", "testapp", "-f", "-y"])
    expect(seen).toEqual(["DELETE /apps/testapp"])
    expect(stderr).toContain("networks siteio-testapp_data")
  })

  test("--keep-data --images --ignore-errors become query flags", async () => {
    await runCli(["apps", "rm", "testapp", "-f", "-y", "--keep-data", "--images", "--ignore-errors"])
    expect(seen).toEqual(["DELETE /apps/testapp?keepData=true&images=true&ignoreErrors=true"])
  })

  test("--json includes the warnings", async () => {
    const { stdout } = await runCli(["--json", "apps", "rm", "testapp", "-f", "-y"])
    expect(JSON.parse(stdout).data.warnings).toHaveLength(1)
  })

  test("sites rm --ignore-errors", async () => {
    await runCli(["sites", "rm", "testsite", "-y", "--ignore-errors"])
    expect(seen).toEqual(["DELETE /sites/testsite?ignoreErrors=true"])
  })
})

describe("removeAppPrompt", () => {
  test("says volumes and data are deleted by default", () => {
    expect(removeAppPrompt("x")).toContain("volumes and data will be deleted")
    expect(removeAppPrompt("x")).toContain("--keep-data")
  })
  test("says they are kept with --keep-data, and mentions --images", () => {
    const text = removeAppPrompt("x", { keepData: true, images: true })
    expect(text).toContain("volumes and data are kept")
    expect(text).toContain("images will be removed")
  })
})
