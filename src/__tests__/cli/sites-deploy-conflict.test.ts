import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawn } from "bun"
import { zipSync, unzipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig } from "../../types.ts"

/**
 * `siteio sites deploy` against a real AgentServer (fake container runtime):
 * a stale folder must be rejected with merge guidance, never silently
 * overwrite a newer server version.
 */

let http: ReturnType<typeof Bun.serve> | null = null
let agent: AgentServer
let dataDir = ""
let homeDir = ""
let folder = ""

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "siteio-conflict-data-"))
  const config: AgentConfig = {
    apiKey: "k", dataDir, domain: "example.com",
    maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
  }
  agent = new AgentServer(config, new FakeRuntime())
  http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => agent.handleRequestForTest(req) })

  homeDir = mkdtempSync(join(tmpdir(), "siteio-conflict-home-"))
  const cfgDir = join(homeDir, ".config", "siteio")
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(
    join(cfgDir, "config.json"),
    JSON.stringify({ current: "test", servers: { test: { apiUrl: `http://127.0.0.1:${http.port}`, apiKey: "k", domain: "example.com" } } })
  )
  folder = join(homeDir, "blog")
  mkdirSync(folder)
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
  return { stdout, stderr, output: stdout + stderr, exitCode: await proc.exited }
}

const deploy = (...extra: string[]) => runCli(["sites", "deploy", folder, "-n", "blog", ...extra])
const writeIndex = (html: string) => writeFileSync(join(folder, "index.html"), html)
const localVersion = () => JSON.parse(readFileSync(join(folder, ".siteio", "config.json"), "utf-8")).version

// Someone else deploys straight to the agent, bypassing this folder.
async function deployElsewhere(html: string): Promise<void> {
  const res = await agent.handleRequestForTest(new Request("http://x/sites/blog", {
    method: "POST",
    headers: { "X-API-Key": "k", "Content-Type": "application/zip" },
    body: zipSync({ "public/index.html": new TextEncoder().encode(html) }),
  }))
  expect(res.status).toBe(200)
}

async function liveIndex(): Promise<string> {
  const res = await agent.handleRequestForTest(
    new Request("http://x/sites/blog/download", { headers: { "X-API-Key": "k" } })
  )
  return new TextDecoder().decode(unzipSync(new Uint8Array(await res.arrayBuffer()))["public/index.html"]!)
}

describe("CLI: sites deploy version conflicts", () => {
  test("a stale folder is rejected, the newer server version survives, and merge steps are shown", async () => {
    writeIndex("mine v1")
    expect((await deploy()).exitCode).toBe(0)
    expect(localVersion()).toBe(1)
    await deployElsewhere("theirs v2")

    writeIndex("mine changed")
    const r = await deploy()
    expect(r.exitCode).toBe(1)
    expect(await liveIndex()).toBe("theirs v2")
    expect(localVersion()).toBe(1) // the rejected deploy must not advance the recorded base
    expect(r.stderr).toContain("based on v1; the server now has v2")
    expect(r.stderr).toContain("-v 1")
    expect(r.stderr).toContain("git merge-file")
    expect(r.stderr).toContain("--expected-version 2")
  })

  test("--json puts a machine-readable conflict on stdout", async () => {
    writeIndex("mine v1")
    await deploy()
    await deployElsewhere("theirs v2")
    await deployElsewhere("theirs v3")

    const r = await deploy("--json")
    expect(r.exitCode).toBe(1)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.success).toBe(false)
    expect(parsed.error.code).toBe("version_conflict")
    expect(parsed.error.expectedVersion).toBe(1)
    expect(parsed.error.currentVersion).toBe(3)
    expect(parsed.error.nextSteps.join("\n")).toContain("--expected-version 3")
  })

  test("--expected-version overrides the folder's stale version and records the new one", async () => {
    writeIndex("mine v1")
    await deploy()
    await deployElsewhere("theirs v2")

    writeIndex("merged")
    const r = await deploy("--expected-version", "2")
    expect(r.exitCode).toBe(0)
    expect(await liveIndex()).toBe("merged")
    expect(localVersion()).toBe(3)
  })

  test("--expected-version is still rejected when someone deployed during the merge", async () => {
    writeIndex("mine v1")
    await deploy()
    await deployElsewhere("theirs v2")
    await deployElsewhere("theirs v3, landed mid-merge")

    writeIndex("merged against v2")
    const r = await deploy("--expected-version", "2")
    expect(r.exitCode).toBe(1)
    expect(await liveIndex()).toBe("theirs v3, landed mid-merge")
    expect(r.stderr).toContain("the server now has v3")
  })

  test("--force and --expected-version together are refused before anything is deployed", async () => {
    writeIndex("mine v1")
    await deploy()
    await deployElsewhere("theirs v2")

    writeIndex("mine changed")
    const r = await deploy("--force", "--expected-version", "2")
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain("cannot be used together")
    expect(await liveIndex()).toBe("theirs v2")
  })

  for (const bad of ["two", "0", "-1", "1.5"]) {
    test(`--expected-version ${bad} is refused instead of skipping the check`, async () => {
      writeIndex("mine v1")
      await deploy()
      await deployElsewhere("theirs v2")

      writeIndex("mine changed")
      const r = await deploy(`--expected-version=${bad}`)
      expect(r.exitCode).toBe(1)
      expect(await liveIndex()).toBe("theirs v2")
    })
  }
})

describe("CLI: sites download --version and the full merge", () => {
  const page = (title: string, footer: string) => `<h1>${title}</h1>\n<p>body</p>\n<p>body</p>\n<p>body</p>\n<footer>${footer}</footer>\n`

  test("following the printed steps merges both changes without losing either", async () => {
    writeIndex(page("Hello", "2025"))
    await deploy()
    await deployElsewhere(page("Bonjour", "2025")) // they change the title

    writeIndex(page("Hello", "2026")) // I change the footer
    const rejected = await deploy("--json")
    expect(rejected.exitCode).toBe(1)
    const { nextSteps } = JSON.parse(rejected.stdout).error as { nextSteps: string[] }

    // Steps 1-2: the two downloads, run exactly as printed.
    for (const step of nextSteps.slice(0, 2)) {
      const r = await runCli(step.split(" ").slice(1))
      expect(r.exitCode).toBe(0)
    }
    const baseDir = nextSteps[0]!.split(" ")[3]!
    const theirsDir = nextSteps[1]!.split(" ")[3]!
    try {
      expect(readFileSync(join(baseDir, "index.html"), "utf-8")).toBe(page("Hello", "2025"))
      expect(readFileSync(join(theirsDir, "index.html"), "utf-8")).toBe(page("Bonjour", "2025"))

      // Step 3: 3-way merge of the one changed file.
      const merge = spawn({ cmd: ["git", "merge-file", join(folder, "index.html"), join(baseDir, "index.html"), join(theirsDir, "index.html")] })
      expect(await merge.exited).toBe(0) // 0 = merged cleanly
      expect(readFileSync(join(folder, "index.html"), "utf-8")).toBe(page("Bonjour", "2026"))

      // Step 4: deploy against the version that was merged.
      const r = await runCli(nextSteps[3]!.split(": ")[1]!.split(" ").slice(1))
      expect(r.exitCode).toBe(0)
      expect(await liveIndex()).toBe(page("Bonjour", "2026"))
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
      rmSync(theirsDir, { recursive: true, force: true })
    }
  })

  test("a downloaded past version records that version, so deploying it is checked against it", async () => {
    writeIndex("one")
    await deploy()
    await deployElsewhere("two")

    const old = join(homeDir, "old")
    const r = await runCli(["sites", "download", old, "-n", "blog", "-v", "1"])
    expect(r.exitCode).toBe(0)
    expect(readFileSync(join(old, "index.html"), "utf-8")).toBe("one")
    expect(JSON.parse(readFileSync(join(old, ".siteio", "config.json"), "utf-8")).version).toBe(1)

    // Deploying the old copy must not overwrite v2.
    const d = await runCli(["sites", "deploy", old])
    expect(d.exitCode).toBe(1)
    expect(await liveIndex()).toBe("two")
  })

  test("a version that is not in history fails and leaves the target folder untouched", async () => {
    writeIndex("one")
    await deploy()
    const target = join(homeDir, "target")
    mkdirSync(target)
    writeFileSync(join(target, "keep.txt"), "mine")

    const r = await runCli(["sites", "download", target, "-n", "blog", "-v", "7", "-y"])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain("Version 7 not found")
    expect(readFileSync(join(target, "keep.txt"), "utf-8")).toBe("mine")
  })

  for (const bad of ["abc", "0", "-2"]) {
    test(`-v ${bad} is refused instead of downloading the current version`, async () => {
      writeIndex("one")
      await deploy()
      const target = join(homeDir, "target")
      const r = await runCli(["sites", "download", target, "-n", "blog", "-v", bad])
      expect(r.exitCode).toBe(1)
      expect(r.output).not.toContain("Downloaded")
    })
  }
})

describe("CLI: the site version flag is not swallowed by the CLI's own --version", () => {
  for (const flag of ["--site-version", "-v"]) {
    test(`rollback ${flag} 1 really rolls back`, async () => {
      writeIndex("one")
      await deploy()
      await deployElsewhere("two")

      const r = await runCli(["sites", "rollback", "blog", flag, "1", "-y"])
      expect(r.exitCode).toBe(0)
      expect(await liveIndex()).toBe("one")
    })

    test(`download ${flag} 1 really downloads version 1`, async () => {
      writeIndex("one")
      await deploy()
      await deployElsewhere("two")

      const target = join(homeDir, "old")
      const r = await runCli(["sites", "download", target, "-n", "blog", flag, "1"])
      expect(r.exitCode).toBe(0)
      expect(readFileSync(join(target, "index.html"), "utf-8")).toBe("one")
    })
  }
})

describe("CLI: the old `--version <n>` form fails loudly instead of printing the CLI version", () => {
  test("rollback --version 1 is refused and nothing is rolled back", async () => {
    writeIndex("one")
    await deploy()
    await deployElsewhere("two")

    const r = await runCli(["sites", "rollback", "blog", "--version", "1", "-y"])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain("unknown option '--version'")
    expect(await liveIndex()).toBe("two")
  })

  test("download --version 1 is refused instead of exiting 0 with no download", async () => {
    writeIndex("one")
    await deploy()
    const target = join(homeDir, "old")
    const r = await runCli(["sites", "download", target, "-n", "blog", "--version", "1"])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain("unknown option '--version'")
  })

  for (const flag of ["--version", "-V"]) {
    test(`siteio ${flag} still prints the CLI version`, async () => {
      const r = await runCli([flag])
      expect(r.exitCode).toBe(0)
      expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
    })
  }

  test("siteio --help still lists --version", async () => {
    const r = await runCli(["--help"])
    expect(r.stdout).toContain("-V, --version")
  })
})
