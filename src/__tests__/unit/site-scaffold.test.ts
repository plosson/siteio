// src/__tests__/unit/site-scaffold.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { scaffoldSite } from "../../lib/site-scaffold.ts"

describe("Unit: scaffoldSite", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "siteio-site-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  test("creates a starter index.html", () => {
    scaffoldSite(dir)
    expect(existsSync(join(dir, "index.html"))).toBe(true)
  })

  test("does not overwrite an existing index.html", () => {
    writeFileSync(join(dir, "index.html"), "<p>mine</p>")
    scaffoldSite(dir)
    expect(readFileSync(join(dir, "index.html"), "utf-8")).toBe("<p>mine</p>")
  })

  test("writes a CLAUDE.md guide covering site commands and capabilities", () => {
    scaffoldSite(dir)
    const guide = join(dir, "CLAUDE.md")
    expect(existsSync(guide)).toBe(true)
    const md = readFileSync(guide, "utf-8")
    // Covers the sites commands
    for (const cmd of ["siteio sites deploy", "siteio sites auth", "siteio sites rollback", "siteio sites domain add"]) {
      expect(md).toContain(cmd)
    }
    // Covers persistent localStorage and points to pockets for backend needs
    expect(md).toContain("--persistent-storage")
    expect(md).toContain("siteio pocket init")
  })

  test("does not overwrite an existing CLAUDE.md", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "keep me")
    scaffoldSite(dir)
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toBe("keep me")
  })

  test("init command module loads", async () => {
    const mod = await import("../../commands/sites/init.ts")
    expect(typeof mod.sitesInitCommand).toBe("function")
  })
})
