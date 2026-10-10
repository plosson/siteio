import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, statSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { spawn } from "bun"

// Exercises `siteio agent config` for the AI-chat LLM keys, which must be
// settable (VALID_KEYS), masked when sensitive, and persisted to the 0600
// agent-config.json.
describe("CLI: agent config (LLM keys)", () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-agent-cfg-"))
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = spawn({
      cmd: ["bun", "run", "src/cli.ts", ...args],
      cwd: process.cwd(),
      env: { ...process.env, SITEIO_DATA_DIR: dataDir },
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

  test("set/get llmApiKey round-trips the raw value", async () => {
    const set = await runCli(["agent", "config", "set", "llmApiKey", "sk-ant-secret-123456"])
    expect(set.exitCode).toBe(0)

    const get = await runCli(["--json", "agent", "config", "get", "llmApiKey"])
    expect(get.exitCode).toBe(0)
    expect(JSON.parse(get.stdout).llmApiKey).toBe("sk-ant-secret-123456")
  })

  test("llmApiKey is masked in list output but llmModel is shown plainly", async () => {
    await runCli(["agent", "config", "set", "llmApiKey", "sk-ant-secret-123456"])
    await runCli(["agent", "config", "set", "llmModel", "claude-sonnet-5"])

    const list = await runCli(["--json", "agent", "config", "list"])
    const cfg = JSON.parse(list.stdout)
    expect(cfg.llmApiKey).toBe("****3456") // last-4 masking
    expect(cfg.llmApiKey).not.toContain("secret")
    expect(cfg.llmModel).toBe("claude-sonnet-5") // non-sensitive
  })

  test("llmOauthToken and llmProvider are accepted keys", async () => {
    expect((await runCli(["agent", "config", "set", "llmOauthToken", "sk-ant-oat-abc"])).exitCode).toBe(0)
    expect((await runCli(["agent", "config", "set", "llmProvider", "anthropic"])).exitCode).toBe(0)
  })

  test("agent-config.json is written 0600", async () => {
    await runCli(["agent", "config", "set", "llmApiKey", "sk-ant-x"])
    const p = join(dataDir, "agent-config.json")
    expect(existsSync(p)).toBe(true)
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })

  test("pagerUrl round-trips but is masked in list output", async () => {
    const url = "https://pagerio.example.com/p/supersecretABCD"
    expect((await runCli(["agent", "config", "set", "pagerUrl", url])).exitCode).toBe(0)

    const get = await runCli(["--json", "agent", "config", "get", "pagerUrl"])
    expect(JSON.parse(get.stdout).pagerUrl).toBe(url)

    const list = await runCli(["--json", "agent", "config", "list"])
    expect(list.stdout).not.toContain("supersecret")
    expect(JSON.parse(list.stdout).pagerUrl).toBe("****ABCD")

    const set = await runCli(["--json", "agent", "config", "set", "pagerUrl", url])
    expect(set.stdout).not.toContain("supersecret")
  })

  test.each(["pagerio.example.com/p/x", "ftp://pagerio.example.com/p/x", "javascript:alert(1)", ""])(
    "pagerUrl rejects a non-http(s) value: %p",
    async (bad) => {
      const res = await runCli(["agent", "config", "set", "pagerUrl", bad])
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toContain("must start with http:// or https://")
      expect(existsSync(join(dataDir, "agent-config.json"))).toBe(false)
    }
  )

  test.each(["dikkenek.example.com/api/deploy", "ftp://x.example.com", "javascript:alert(1)", ""])(
    "rankingUrl rejects a non-http(s) value: %p",
    async (bad) => {
      const res = await runCli(["agent", "config", "set", "rankingUrl", bad])
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toContain("rankingUrl must start with http:// or https://")
      expect(existsSync(join(dataDir, "agent-config.json"))).toBe(false)
    }
  )

  test("rankingUrl is stored next to pagerUrl without replacing it", async () => {
    const pager = "https://pagerio.example.com/p/secret"
    const ranking = "https://dikkenek.example.com/api/deploy"
    expect((await runCli(["agent", "config", "set", "pagerUrl", pager])).exitCode).toBe(0)
    expect((await runCli(["agent", "config", "set", "rankingUrl", ranking])).exitCode).toBe(0)
    expect(JSON.parse((await runCli(["--json", "agent", "config", "get", "pagerUrl"])).stdout).pagerUrl).toBe(pager)
    expect(JSON.parse((await runCli(["--json", "agent", "config", "get", "rankingUrl"])).stdout).rankingUrl).toBe(ranking)
  })

  test.each(["analytics.example.com/api/ingest", "ftp://x.example.com", "javascript:alert(1)", ""])(
    "analyticsUrl rejects a non-http(s) value: %p",
    async (bad) => {
      const res = await runCli(["agent", "config", "set", "analyticsUrl", bad])
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toContain("analyticsUrl must start with http:// or https://")
      expect(existsSync(join(dataDir, "agent-config.json"))).toBe(false)
    }
  )

  test("analyticsUrl is masked in config list: the URL is the secret", async () => {
    const url = "https://analytics.example.com/api/ingest?key=topsecretvalue"
    expect((await runCli(["agent", "config", "set", "analyticsUrl", url])).exitCode).toBe(0)
    const list = await runCli(["--json", "agent", "config", "list"])
    expect(list.stdout).not.toContain("topsecretvalue")
    expect(JSON.parse((await runCli(["--json", "agent", "config", "get", "analyticsUrl"])).stdout).analyticsUrl).toBe(url)
  })

  test("an unknown key is still rejected", async () => {
    const res = await runCli(["agent", "config", "set", "bogusKey", "x"])
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("Unknown config key")
  })
})
