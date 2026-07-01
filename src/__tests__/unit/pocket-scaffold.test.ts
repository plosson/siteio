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
})
