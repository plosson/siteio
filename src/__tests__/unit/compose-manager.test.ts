import { describe, test, expect } from "bun:test"
import { ComposeManager } from "../../lib/agent/compose"

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
    const args = cm.buildLogsArgs("siteio-x", ["/base.yml"], { tail: 50 })
    expect(args).toEqual([
      "compose", "-p", "siteio-x", "-f", "/base.yml",
      "logs", "--no-color", "--tail", "50",
    ])
  })

  test("buildLogsArgs with service appends the service name", () => {
    const args = cm.buildLogsArgs("siteio-x", ["/base.yml"], { tail: 100, service: "web" })
    expect(args).toEqual([
      "compose", "-p", "siteio-x", "-f", "/base.yml",
      "logs", "--no-color", "--tail", "100", "web",
    ])
  })

  test("buildLogsArgs with all ignores service (all = everything)", () => {
    const args = cm.buildLogsArgs("siteio-x", ["/base.yml"], { tail: 100, all: true, service: "web" })
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
})
