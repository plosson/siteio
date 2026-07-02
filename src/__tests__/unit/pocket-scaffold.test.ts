// src/__tests__/unit/pocket-scaffold.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { scaffoldPocket } from "../../lib/pocket-scaffold.ts"

describe("Unit: scaffoldPocket", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "siteio-pocket-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  test("creates the .siteio plumbing and a starter index.html", () => {
    scaffoldPocket(dir)
    expect(existsSync(join(dir, "index.html"))).toBe(true)
    expect(existsSync(join(dir, ".siteio", "pb_migrations"))).toBe(true)
    expect(existsSync(join(dir, ".siteio", "pb_hooks"))).toBe(true)
  })

  test("gitignores the local pb_data sandbox", () => {
    scaffoldPocket(dir)
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8")
    expect(gitignore).toContain(".siteio/pb_data/")
  })

  test("does not overwrite an existing index.html", () => {
    writeFileSync(join(dir, "index.html"), "<p>mine</p>")
    scaffoldPocket(dir)
    expect(readFileSync(join(dir, "index.html"), "utf-8")).toBe("<p>mine</p>")
  })

  test("writes a CLAUDE.md guide covering commands and the PocketBase JS client", () => {
    scaffoldPocket(dir)
    const guide = join(dir, "CLAUDE.md")
    expect(existsSync(guide)).toBe(true)
    const md = readFileSync(guide, "utf-8")
    // Covers the pocket commands
    for (const cmd of ["siteio pocket dev", "siteio pocket deploy", "siteio pocket admin"]) {
      expect(md).toContain(cmd)
    }
    // Makes the PocketBase JS client the way to add storage
    expect(md).toContain("PocketBase JS client")
    expect(md).toContain("pocketbase.umd.js")
    expect(md).toContain("new PocketBase(")
  })

  test("does not overwrite an existing CLAUDE.md", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "keep me")
    scaffoldPocket(dir)
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toBe("keep me")
  })
})
