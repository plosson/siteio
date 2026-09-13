import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { writeFileSync } from "fs"
import { join } from "path"
import { startMockAgent, type MockAgent } from "../helpers/mock-agent"

/**
 * CLI flag-propagation tests for `siteio apps deploy`.
 *
 * Regression: Commander's boolean-negation convention sets
 * `options.cache = false` when `--no-cache` is passed — NOT
 * `options.noCache = true`. The action handler has to translate. If it
 * forgets, the flag is silently dropped on the wire (no `?noCache=true`
 * query param reaches the agent), docker keeps its layer cache, and
 * users get stale binaries without any error.
 *
 * This test pins the translation by spawning the CLI against a minimal
 * mock agent and asserting the actual query string / body it receives.
 */

let agent: MockAgent

beforeAll(() => {
  // Canned response matching what the CLI expects from a successful deploy.
  agent = startMockAgent("flag-test-key", () => ({
    success: true,
    data: { name: "testapp", status: "running", domains: [] },
  }))
})

afterAll(() => agent.stop())

const runCli = (args: string[]) => agent.run(args)

function deployRequest() {
  const deploy = agent.recorded.find((r) => r.method === "POST" && r.path === "/apps/testapp/deploy")
  if (!deploy) throw new Error("expected a POST /apps/testapp/deploy")
  return deploy
}

describe("CLI: apps deploy --no-cache flag propagation", () => {
  test("without --no-cache: no noCache query param on the wire", async () => {
    const result = await runCli(["apps", "deploy", "testapp"])
    expect(result.exitCode).toBe(0)

    const deploy = deployRequest()
    expect(deploy.search).toBe("")
  })

  test("--no-cache: ?noCache=true query param reaches the agent", async () => {
    const result = await runCli(["apps", "deploy", "testapp", "--no-cache"])
    expect(result.exitCode).toBe(0)

    const deploy = deployRequest()
    // The literal contract with the agent: query must be `?noCache=true`.
    // If Commander's --no-cache convention isn't translated in the action
    // handler, this assertion fails (search will be "" instead).
    expect(deploy.search).toBe("?noCache=true")
  })

  test("-f <file>: sends Dockerfile content in JSON body (with --no-cache)", async () => {
    const dockerfilePath = join(agent.homeDir, "probe.Dockerfile")
    const dockerfile = `FROM alpine:latest\nCMD ["echo","hello"]\n`
    writeFileSync(dockerfilePath, dockerfile)

    const result = await runCli([
      "apps",
      "deploy",
      "testapp",
      "--no-cache",
      "-f",
      dockerfilePath,
    ])
    expect(result.exitCode).toBe(0)

    const deploy = deployRequest()
    expect(deploy.search).toBe("?noCache=true")
    expect(deploy.bodyJson).toEqual({ dockerfileContent: dockerfile })
  })
})
