import { describe, test, expect } from "bun:test"
import { ComposeManager, parsePsOutput } from "../../lib/agent/compose"

describe("Unit: ComposeManager.buildArgs", () => {
  const cm = new ComposeManager()

  test("buildBaseArgs includes project + files", () => {
    const args = cm.buildBaseArgs("siteio-myapp", ["/base.yml", "/over.yml"])
    expect(args).toEqual(["compose", "-p", "siteio-myapp", "-f", "/base.yml", "-f", "/over.yml"])
  })

  test("buildUpArgs appends up -d --build --remove-orphans", () => {
    const args = cm.buildUpArgs("siteio-x", ["/base.yml", "/over.yml"])
    expect(args).toEqual([
      "compose", "-p", "siteio-x", "-f", "/base.yml", "-f", "/over.yml",
      "up", "-d", "--build", "--remove-orphans",
    ])
  })

  test("buildDownArgs appends down -v --remove-orphans", () => {
    const args = cm.buildDownArgs("siteio-x", ["/base.yml"])
    expect(args).toEqual([
      "compose", "-p", "siteio-x", "-f", "/base.yml",
      "down", "-v", "--remove-orphans",
    ])
  })

  test("buildConfigArgs appends config --format json", () => {
    const args = cm.buildConfigArgs("siteio-x", ["/base.yml"])
    expect(args).toEqual([
      "compose", "-p", "siteio-x", "-f", "/base.yml",
      "config", "--format", "json",
    ])
  })

  test("buildLogsArgs with no service passes --tail and no service filter", () => {
    const args = cm.buildLogsArgs("siteio-x", ["/base.yml"], undefined, { tail: 50 })
    expect(args).toEqual([
      "compose", "-p", "siteio-x", "-f", "/base.yml",
      "logs", "--no-color", "--tail", "50",
    ])
  })

  test("buildLogsArgs with service appends the service name", () => {
    const args = cm.buildLogsArgs("siteio-x", ["/base.yml"], undefined, { tail: 100, service: "web" })
    expect(args).toEqual([
      "compose", "-p", "siteio-x", "-f", "/base.yml",
      "logs", "--no-color", "--tail", "100", "web",
    ])
  })

  test("buildLogsArgs with all ignores service (all = everything)", () => {
    const args = cm.buildLogsArgs("siteio-x", ["/base.yml"], undefined, { tail: 100, all: true, service: "web" })
    expect(args).toEqual([
      "compose", "-p", "siteio-x", "-f", "/base.yml",
      "logs", "--no-color", "--tail", "100",
    ])
  })

  test("buildStopArgs / buildRestartArgs / buildPsArgs shapes", () => {
    expect(cm.buildStopArgs("siteio-x", ["/b.yml"]).slice(-1)).toEqual(["stop"])
    expect(cm.buildRestartArgs("siteio-x", ["/b.yml"]).slice(-1)).toEqual(["restart"])
    expect(cm.buildPsArgs("siteio-x", ["/b.yml"]).slice(-3)).toEqual(["ps", "--format", "json"])
  })

  test("buildBaseArgs includes --env-file when provided", () => {
    const args = cm.buildBaseArgs("siteio-x", ["/base.yml"], "/env/.env")
    expect(args).toEqual([
      "compose", "-p", "siteio-x", "-f", "/base.yml", "--env-file", "/env/.env"
    ])
  })

  test("buildBaseArgs omits --env-file when not provided", () => {
    const args = cm.buildBaseArgs("siteio-x", ["/base.yml"])
    expect(args).not.toContain("--env-file")
  })

  test("buildUpArgs threads envFile through buildBaseArgs", () => {
    const args = cm.buildUpArgs("siteio-x", ["/base.yml"], "/e.env")
    // envFile must appear BEFORE the subcommand
    const subcommandIdx = args.indexOf("up")
    const envFlagIdx = args.indexOf("--env-file")
    expect(envFlagIdx).toBeGreaterThan(-1)
    expect(envFlagIdx).toBeLessThan(subcommandIdx)
  })

  test("buildLogsArgs with envFile places it before the subcommand", () => {
    const args = cm.buildLogsArgs("siteio-x", ["/base.yml"], "/e.env", { tail: 100 })
    const logsIdx = args.indexOf("logs")
    const envFlagIdx = args.indexOf("--env-file")
    expect(envFlagIdx).toBeGreaterThan(-1)
    expect(envFlagIdx).toBeLessThan(logsIdx)
  })

  test("buildDownArgs with envFile", () => {
    const args = cm.buildDownArgs("siteio-x", ["/b.yml"], "/e")
    expect(args).toContain("--env-file")
    expect(args.slice(-3)).toEqual(["down", "-v", "--remove-orphans"])
  })
})

describe("Unit: parsePsOutput", () => {
  test("empty output returns empty array", () => {
    expect(parsePsOutput("")).toEqual([])
    expect(parsePsOutput("   \n  ")).toEqual([])
  })

  test("parses JSON array shape (older docker)", () => {
    const raw = JSON.stringify([
      { Service: "web", ID: "abc123", State: "running" },
      { Service: "db", ID: "def456", State: "running" },
    ])
    expect(parsePsOutput(raw)).toEqual([
      { service: "web", containerId: "abc123", state: "running" },
      { service: "db", containerId: "def456", state: "running" },
    ])
  })

  test("parses NDJSON shape (newer docker, one object per line)", () => {
    const raw = [
      JSON.stringify({ Service: "web", ID: "abc123", State: "running" }),
      JSON.stringify({ Service: "db", ID: "def456", State: "exited" }),
    ].join("\n")
    expect(parsePsOutput(raw)).toEqual([
      { service: "web", containerId: "abc123", state: "running" },
      { service: "db", containerId: "def456", state: "exited" },
    ])
  })

  test("throws SiteioError on malformed JSON", () => {
    expect(() => parsePsOutput("not json")).toThrow(/Failed to parse compose ps output/)
  })

  test("handles trailing newlines in NDJSON", () => {
    const raw = JSON.stringify({ Service: "web", ID: "a", State: "running" }) + "\n\n"
    expect(parsePsOutput(raw)).toEqual([
      { service: "web", containerId: "a", state: "running" },
    ])
  })
})
