import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { writeFileSync } from "fs"
import { join } from "path"
import { startMockAgent, type MockAgent } from "../helpers/mock-agent"

/**
 * CLI flag tests for the secret-setting surface of `siteio apps set`.
 *
 * What matters here is the wire: a secret must travel in `secrets` (which the
 * agent encrypts) and never in `env` (which the agent stores and echoes back
 * in the clear), and the CLI's own output must not print the value it just
 * sent. `--secret-file` / `--secret-stdin` exist so the value never reaches
 * shell history or the process list, so they are checked end to end.
 */

const SECRET = "not-a-secret-probe-value"

let agent: MockAgent

beforeAll(() => {
  // The agent returns key names only — never a secret value.
  agent = startMockAgent("secret-flag-test-key", () => ({
    success: true,
    data: {
      name: "testapp",
      status: "stopped",
      env: {},
      secretKeys: ["VAULT_PASSPHRASE"],
      domains: [],
      volumes: [],
    },
  }))
})

afterAll(() => agent.stop())

const runCli = (args: string[], stdin?: string) => agent.run(args, stdin)

function patchBody(): Record<string, unknown> {
  const patch = agent.recorded.find((r) => r.method === "PATCH" && r.path === "/apps/testapp")
  if (!patch) throw new Error("expected a PATCH /apps/testapp")
  return patch.bodyJson ?? {}
}

describe("CLI: apps set secret flags", () => {
  test("--secret sends the value in `secrets`, never in `env`", async () => {
    const result = await runCli(["apps", "set", "testapp", "--secret", `VAULT_PASSPHRASE=${SECRET}`])
    expect(result.exitCode).toBe(0)

    const body = patchBody()
    expect(body.secrets).toEqual({ VAULT_PASSPHRASE: SECRET })
    expect(body.env).toBeUndefined()
  })

  test("--secret does not print the value back", async () => {
    const result = await runCli(["apps", "set", "testapp", "--secret", `VAULT_PASSPHRASE=${SECRET}`])
    expect(result.stdout + result.stderr).not.toContain(SECRET)
    expect(result.stdout).toContain("VAULT_PASSPHRASE")
  })

  test("-e still sends plain env vars", async () => {
    const result = await runCli(["apps", "set", "testapp", "-e", "NODE_ENV=production"])
    expect(result.exitCode).toBe(0)

    const body = patchBody()
    expect(body.env).toEqual({ NODE_ENV: "production" })
    expect(body.secrets).toBeUndefined()
  })

  test("--secret-file reads the value from a file and drops its trailing newline", async () => {
    const secretPath = join(agent.homeDir, "passphrase.txt")
    writeFileSync(secretPath, `${SECRET}\n`)

    const result = await runCli(["apps", "set", "testapp", "--secret-file", `VAULT_PASSPHRASE=${secretPath}`])
    expect(result.exitCode).toBe(0)
    expect(patchBody().secrets).toEqual({ VAULT_PASSPHRASE: SECRET })
    expect(result.stdout + result.stderr).not.toContain(SECRET)
  })

  test("--secret-file fails clearly on a missing file", async () => {
    const result = await runCli(["apps", "set", "testapp", "--secret-file", `K=${join(agent.homeDir, "nope.txt")}`])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Secret file not found")
  })

  test("--secret-stdin reads the value from stdin", async () => {
    const result = await runCli(["apps", "set", "testapp", "--secret-stdin", "VAULT_PASSPHRASE"], `${SECRET}\n`)
    expect(result.exitCode).toBe(0)
    expect(patchBody().secrets).toEqual({ VAULT_PASSPHRASE: SECRET })
    expect(result.stdout + result.stderr).not.toContain(SECRET)
  })

  test("apps info masks secret keys and has no way to reveal them", async () => {
    const result = await runCli(["apps", "info", "testapp"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("VAULT_PASSPHRASE=••••••••")
    expect(result.stdout).toContain("(secret)")

    // There is deliberately no --reveal: a secret is write-only once set.
    const help = await runCli(["apps", "info", "--help"])
    expect(help.stdout + help.stderr).not.toContain("--reveal")
  })

  test("rejects a key given as both --env and --secret", async () => {
    const result = await runCli([
      "apps",
      "set",
      "testapp",
      "-e",
      `VAULT_PASSPHRASE=${SECRET}`,
      "--secret",
      `VAULT_PASSPHRASE=${SECRET}`,
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Pick one")
    expect(agent.recorded.some((r) => r.method === "PATCH")).toBe(false)
  })
})
