import { describe, test, expect } from "bun:test"
import { ComposeManager, composeWarnings, parsePsOutput } from "../../lib/agent/compose"

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
    expect(cm.buildPsArgs("siteio-x", ["/b.yml"]).slice(-4)).toEqual(["ps", "--all", "--format", "json"])
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

  test("keeps exit code and health so failed services can be told apart", () => {
    const raw = [
      JSON.stringify({ Service: "migrate", ID: "m", State: "exited", ExitCode: 0, Health: "" }),
      JSON.stringify({ Service: "api", ID: "a", State: "exited", ExitCode: 137, Health: "" }),
      JSON.stringify({ Service: "db", ID: "d", State: "running", ExitCode: 0, Health: "unhealthy" }),
    ].join("\n")
    expect(parsePsOutput(raw)).toEqual([
      { service: "migrate", containerId: "m", state: "exited", exitCode: 0 },
      { service: "api", containerId: "a", state: "exited", exitCode: 137 },
      { service: "db", containerId: "d", state: "running", exitCode: 0, health: "unhealthy" },
    ])
  })

  test("ignores a non-numeric ExitCode instead of passing it through", () => {
    const raw = JSON.stringify({ Service: "web", ID: "w", State: "running", ExitCode: "1" })
    expect(parsePsOutput(raw)[0]!.exitCode).toBeUndefined()
  })

  test("handles trailing newlines in NDJSON", () => {
    const raw = JSON.stringify({ Service: "web", ID: "a", State: "running" }) + "\n\n"
    expect(parsePsOutput(raw)).toEqual([
      { service: "web", containerId: "a", state: "running" },
    ])
  })
})

describe("Unit: composeWarnings", () => {
  const root = "/data/compose"

  test("a clean stack has no warnings", () => {
    const spec = { services: { web: { volumes: [{ type: "volume", source: "data", target: "/data" }] }, db: {} } }
    expect(composeWarnings(spec, "web", root)).toEqual([])
  })

  test("ports on the primary and on a sidecar get different advice", () => {
    const w = composeWarnings({ services: { web: { ports: ["80:80"] }, db: { ports: ["5432:5432"] } } }, "web", root)
    expect(w).toHaveLength(2)
    expect(w[0]).toContain("Primary service 'web' publishes ports")
    expect(w[1]).toContain("Service 'db' publishes ports")
    expect(w[1]).toContain("outside HTTPS")
  })

  test("resolved port objects are shown as published:target", () => {
    const ports = [{ mode: "ingress", target: 80, published: "8080", protocol: "tcp" }, { target: 9000 }]
    const [w] = composeWarnings({ services: { web: { ports } } }, "web", root)
    expect(w).toContain("(8080:80, 9000)")
  })

  test("an empty ports list is not a warning", () => {
    expect(composeWarnings({ services: { web: { ports: [] } } }, "web", root)).toEqual([])
  })

  test("relative bind mounts (resolved under the upload folder) are flagged, in or beside the app folder", () => {
    const spec = {
      services: {
        web: {
          volumes: [
            { type: "bind", source: "/data/compose/myapp/data", target: "/data" },
            { type: "bind", source: "/data/compose/outside", target: "/o" },
          ],
        },
      },
    }
    const w = composeWarnings(spec, "web", root)
    expect(w).toHaveLength(2)
    expect(w[0]).toContain("'/data'")
    expect(w[0]).toContain("named volume")
  })

  test("absolute host paths and siteio volumes are not flagged", () => {
    const spec = {
      services: {
        web: {
          volumes: [
            { type: "bind", source: "/srv/shared", target: "/s" },
            { type: "bind", source: "/data/volumes/myapp/x", target: "/x" },
            { type: "bind", source: "/data/composer/x", target: "/c" }, // prefix of the root name, not inside it
          ],
        },
      },
    }
    expect(composeWarnings(spec, "web", root)).toEqual([])
  })

  test("git-sourced stacks (no upload root) never get the bind-mount warning", () => {
    const spec = { services: { web: { volumes: [{ type: "bind", source: "/data/compose/myapp/data", target: "/d" }] } } }
    expect(composeWarnings(spec, "web")).toEqual([])
  })

  test("a root given with a trailing separator behaves the same", () => {
    const spec = { services: { web: { volumes: [{ type: "bind", source: "/data/compose/a/b", target: "/d" }] } } }
    expect(composeWarnings(spec, "web", "/data/compose/")).toHaveLength(1)
  })

  test("tolerates null services and malformed volume entries", () => {
    const spec = { services: { web: null, db: { volumes: "nope" } } } as unknown as Parameters<typeof composeWarnings>[0]
    expect(composeWarnings(spec, "web", root)).toEqual([])
  })
})
