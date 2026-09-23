import { describe, test, expect } from "bun:test"
import { asRoot } from "../../commands/agent/sudo.ts"

describe("Unit: asRoot", () => {
  test("runs the command directly as root, so hosts without sudo still work", () => {
    expect(asRoot(["systemctl", "restart", "siteio-agent"], 0)).toEqual(["systemctl", "restart", "siteio-agent"])
  })
  test("prefixes sudo for a non-root user", () => {
    expect(asRoot(["systemctl", "stop", "siteio-agent"], 1000)).toEqual(["sudo", "systemctl", "stop", "siteio-agent"])
  })
  // No getuid (e.g. Windows): don't assume root.
  test("prefixes sudo when the uid is unknown", () => {
    expect(asRoot(["systemctl", "stop", "siteio-agent"], undefined)).toEqual(["sudo", "systemctl", "stop", "siteio-agent"])
  })
  test("does not mutate the caller's array", () => {
    const cmd = ["systemctl", "restart", "siteio-agent"]
    asRoot(cmd, 1000)
    expect(cmd).toEqual(["systemctl", "restart", "siteio-agent"])
  })
})
