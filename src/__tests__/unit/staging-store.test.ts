import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { unzipSync } from "fflate"
import { StagingStore, MAX_STAGING_FILE_SIZE } from "../../lib/agent/staging-store.ts"

describe("Unit: StagingStore", () => {
  let dataDir: string
  let codePath: string
  let store: StagingStore
  const GRANT = "grt_test01"

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-staging-"))
    // A fake current-site code dir: public/ web root + backend dirs.
    codePath = join(dataDir, "code")
    mkdirSync(join(codePath, "public", "css"), { recursive: true })
    mkdirSync(join(codePath, "pb_migrations"), { recursive: true })
    mkdirSync(join(codePath, "pb_hooks"), { recursive: true })
    writeFileSync(join(codePath, "public", "index.html"), "<h1>original</h1>")
    writeFileSync(join(codePath, "public", "css", "style.css"), "body{}")
    writeFileSync(join(codePath, "pb_migrations", "1_init.js"), "// migration")
    writeFileSync(join(codePath, "pb_hooks", "main.pb.js"), "// hook")
    store = new StagingStore(dataDir)
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  test("seed copies only the web root, flattened (no public/ prefix, no backend)", () => {
    store.seed(GRANT, codePath, 3)
    expect(store.listFiles(GRANT).sort()).toEqual(["css/style.css", "index.html"])
    expect(store.seededVersion(GRANT)).toBe(3)
  })

  test("seed is idempotent (does not clobber edits)", () => {
    store.seed(GRANT, codePath, 1)
    store.writeFile(GRANT, "index.html", "<h1>edited</h1>")
    store.seed(GRANT, codePath, 1) // second seed is a no-op
    expect(store.readFile(GRANT, "index.html").content).toBe("<h1>edited</h1>")
  })

  test("read/write/delete round-trip", () => {
    store.seed(GRANT, codePath, 1)
    expect(store.readFile(GRANT, "index.html").content).toBe("<h1>original</h1>")

    store.writeFile(GRANT, "about.html", "<h1>about</h1>")
    expect(store.listFiles(GRANT)).toContain("about.html")

    expect(store.deleteFile(GRANT, "about.html")).toBe(true)
    expect(store.listFiles(GRANT)).not.toContain("about.html")
    expect(store.deleteFile(GRANT, "missing.html")).toBe(false)
  })

  test("rejects path traversal and absolute paths", () => {
    store.seed(GRANT, codePath, 1)
    expect(() => store.writeFile(GRANT, "../escape.txt", "x")).toThrow()
    expect(() => store.writeFile(GRANT, "../../etc/passwd", "x")).toThrow()
    expect(() => store.writeFile(GRANT, "/etc/passwd", "x")).toThrow()
    expect(() => store.readFile(GRANT, "../code/pb_hooks/main.pb.js")).toThrow()
  })

  test("enforces the per-file size cap", () => {
    store.seed(GRANT, codePath, 1)
    const tooBig = "a".repeat(MAX_STAGING_FILE_SIZE + 1)
    expect(() => store.writeFile(GRANT, "big.txt", tooBig)).toThrow(/too large/)
  })

  test("base64 encoding round-trips binary content", () => {
    store.seed(GRANT, codePath, 1)
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe])
    store.writeFile(GRANT, "img.bin", bytes.toString("base64"), "base64")
    const read = store.readFile(GRANT, "img.bin")
    expect(read.encoding).toBe("base64")
    expect(Buffer.from(read.content, "base64")).toEqual(bytes)
  })

  test("buildDeployZip merges staged web files under public/ with untouched backend dirs", () => {
    store.seed(GRANT, codePath, 1)
    store.writeFile(GRANT, "index.html", "<h1>edited</h1>")
    store.writeFile(GRANT, "new.js", "console.log(1)")

    const zip = unzipSync(store.buildDeployZip(GRANT, codePath))
    const dec = (k: string) => new TextDecoder().decode(zip[k]!)

    // Web edits land under public/
    expect(dec("public/index.html")).toBe("<h1>edited</h1>")
    expect(dec("public/css/style.css")).toBe("body{}")
    expect(dec("public/new.js")).toBe("console.log(1)")
    // Backend preserved verbatim, NOT wrapped in public/
    expect(dec("pb_migrations/1_init.js")).toBe("// migration")
    expect(dec("pb_hooks/main.pb.js")).toBe("// hook")
    expect(zip["public/pb_migrations/1_init.js"]).toBeUndefined()
  })

  test("remove deletes the whole staging dir", () => {
    store.seed(GRANT, codePath, 1)
    expect(store.isSeeded(GRANT)).toBe(true)
    store.remove(GRANT)
    expect(store.isSeeded(GRANT)).toBe(false)
    expect(existsSync(join(dataDir, "share-staging", GRANT))).toBe(false)
  })
})
