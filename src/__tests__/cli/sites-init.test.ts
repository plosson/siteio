import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { scaffoldSite } from "../../lib/site-scaffold.ts"

// sitesInitCommand calls process.exit; test the scaffold contract it relies on
// plus that the command module imports cleanly.
describe("CLI: pocket init contract", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "siteio-init-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("scaffold produces a deployable layout", () => {
    scaffoldSite(dir)
    expect(existsSync(join(dir, "index.html"))).toBe(true)
    expect(existsSync(join(dir, ".siteio", "pb_migrations"))).toBe(true)
  })

  test("init command module loads", async () => {
    const mod = await import("../../commands/sites/init.ts")
    expect(typeof mod.sitesInitCommand).toBe("function")
  })
})
