import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawn } from "bun"

/**
 * A mock agent plus a `runCli` that points the real CLI at it, for tests that
 * assert what a command actually puts on the wire (flags, query params, JSON
 * bodies) rather than what the agent does with it.
 *
 * The CLI is spawned as a subprocess with HOME/XDG_CONFIG_HOME redirected at a
 * throwaway config, so it resolves the mock as its current server.
 */

export interface RecordedRequest {
  method: string
  path: string
  search: string
  bodyJson: Record<string, unknown> | null
}

export interface MockAgent {
  /** Requests seen since the last runCli (or resetRecorded). */
  recorded: RecordedRequest[]
  resetRecorded(): void
  /** Temp HOME the CLI config lives in — handy for test fixture files. */
  homeDir: string
  run(args: string[], stdin?: string): Promise<{ stdout: string; stderr: string; exitCode: number }>
  stop(): void
}

/**
 * `respond` returns the canned body for each request; give it whatever shape
 * the command under test expects to parse.
 */
export function startMockAgent(
  apiKey: string,
  respond: (req: RecordedRequest) => unknown
): MockAgent {
  let recorded: RecordedRequest[] = []

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      let bodyJson: Record<string, unknown> | null = null
      if ((req.headers.get("content-type") ?? "").includes("application/json")) {
        try {
          bodyJson = (await req.json()) as Record<string, unknown>
        } catch {
          bodyJson = null
        }
      }
      const entry: RecordedRequest = {
        method: req.method,
        path: url.pathname,
        search: url.search,
        bodyJson,
      }
      recorded.push(entry)

      return new Response(JSON.stringify(respond(entry)), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })
  if (server.port == null) {
    throw new Error("Bun.serve did not assign a port")
  }

  const homeDir = mkdtempSync(join(tmpdir(), "siteio-mock-agent-"))
  const cfgDir = join(homeDir, ".config", "siteio")
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(
    join(cfgDir, "config.json"),
    JSON.stringify({
      current: "test",
      servers: { test: { apiUrl: `http://127.0.0.1:${server.port}`, apiKey } },
    })
  )

  const agent: MockAgent = {
    get recorded() {
      return recorded
    },
    resetRecorded() {
      recorded = []
    },
    homeDir,
    async run(args, stdin) {
      recorded = []
      const proc = spawn({
        cmd: ["bun", "run", "src/cli.ts", ...args],
        cwd: process.cwd(),
        env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: join(homeDir, ".config") },
        stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      return { stdout, stderr, exitCode: await proc.exited }
    },
    stop() {
      server.stop()
      rmSync(homeDir, { recursive: true, force: true })
    },
  }
  return agent
}
