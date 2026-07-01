import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { collectPocketFiles } from "../../commands/pocket/deploy.ts"

describe("Unit: collectPocketFiles", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "siteio-pd-"))
    writeFileSync(join(dir, "index.html"), "<h1>hi</h1>")
    mkdirSync(join(dir, ".siteio", "pb_migrations"), { recursive: true })
    writeFileSync(join(dir, ".siteio", "pb_migrations", "1_init.js"), "// mig")
    mkdirSync(join(dir, ".siteio", "pb_hooks"), { recursive: true })
    writeFileSync(join(dir, ".siteio", "pb_hooks", "main.pb.js"), "// hook")
    mkdirSync(join(dir, ".siteio", "pb_data"), { recursive: true })
    writeFileSync(join(dir, ".siteio", "pb_data", "data.db"), "SECRET")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("maps web root to public/ and includes migrations + hooks", async () => {
    const files = await collectPocketFiles(dir)
    expect(Object.keys(files)).toContain("public/index.html")
    expect(Object.keys(files)).toContain("pb_migrations/1_init.js")
    expect(Object.keys(files)).toContain("pb_hooks/main.pb.js")
  })

  test("NEVER includes pb_data", async () => {
    const files = await collectPocketFiles(dir)
    const leaked = Object.keys(files).filter((k) => k.includes("pb_data"))
    expect(leaked).toEqual([])
  })
})
