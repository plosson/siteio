import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync, unzipSync } from "fflate"
import { collectPocketFiles } from "../../commands/pocket/deploy.ts"
import { toLocalPath } from "../../lib/pocket-layout.ts"
import { PocketStorage } from "../../lib/agent/pocket-storage.ts"
import type { Pocket } from "../../types.ts"

// Full layout round-trip: local project -> deploy artifact -> server code store
// -> download zip -> reconstructed local project. Proves download is the exact
// inverse of deploy for the parts that travel.
describe("Unit: pocket download round-trip", () => {
  let projectDir: string
  let serverDir: string
  let outDir: string
  let storage: PocketStorage

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "siteio-dl-src-"))
    serverDir = mkdtempSync(join(tmpdir(), "siteio-dl-srv-"))
    outDir = mkdtempSync(join(tmpdir(), "siteio-dl-out-"))
    storage = new PocketStorage(serverDir)

    // A representative pocket project.
    writeFileSync(join(projectDir, "index.html"), "<h1>home</h1>")
    writeFileSync(join(projectDir, "pb.js"), "// client")
    mkdirSync(join(projectDir, "tools"), { recursive: true })
    writeFileSync(join(projectDir, "tools", "app.js"), "// tool")
    mkdirSync(join(projectDir, ".siteio", "pb_migrations"), { recursive: true })
    writeFileSync(join(projectDir, ".siteio", "pb_migrations", "1_init.js"), "// mig")
    mkdirSync(join(projectDir, ".siteio", "pb_hooks"), { recursive: true })
    writeFileSync(join(projectDir, ".siteio", "pb_hooks", "main.pb.js"), "// hook")
    // Local-only bits that must NOT round-trip.
    writeFileSync(join(projectDir, ".siteio", "config.json"), JSON.stringify({ pocket: "demo" }))
    mkdirSync(join(projectDir, ".siteio", "pb_data"), { recursive: true })
    writeFileSync(join(projectDir, ".siteio", "pb_data", "data.db"), "SECRET")
  })

  afterEach(() => {
    for (const d of [projectDir, serverDir, outDir]) rmSync(d, { recursive: true, force: true })
  })

  const base = (name: string): Omit<Pocket, "createdAt" | "updatedAt"> => ({
    name, domains: [`${name}.example.com`], pocketbaseVersion: "0.23.4", status: "pending", size: 0,
  })

  test("reconstructs the original project layout", async () => {
    // Deploy: collect -> zip -> server extractCode.
    const artifact = await collectPocketFiles(projectDir)
    storage.create(base("demo"))
    await storage.extractCode("demo", zipSync(artifact, { level: 6 }))

    // Download: server zips code, client reverses the layout into outDir.
    const codeZip = await storage.zipCode("demo")
    expect(codeZip).not.toBeNull()
    const entries = unzipSync(codeZip!)
    for (const [entry, data] of Object.entries(entries)) {
      if (entry.endsWith("/")) continue
      const local = toLocalPath(entry)
      if (!local) continue
      const p = join(outDir, local)
      mkdirSync(join(p, ".."), { recursive: true })
      writeFileSync(p, data)
    }

    // Web files land back at the root, unchanged.
    expect(readFileSync(join(outDir, "index.html"), "utf-8")).toBe("<h1>home</h1>")
    expect(readFileSync(join(outDir, "pb.js"), "utf-8")).toBe("// client")
    expect(readFileSync(join(outDir, "tools", "app.js"), "utf-8")).toBe("// tool")

    // Backend code lands back under .siteio/.
    expect(readFileSync(join(outDir, ".siteio", "pb_migrations", "1_init.js"), "utf-8")).toBe("// mig")
    expect(readFileSync(join(outDir, ".siteio", "pb_hooks", "main.pb.js"), "utf-8")).toBe("// hook")
  })

  test("never carries pb_data through the round-trip", async () => {
    const artifact = await collectPocketFiles(projectDir)
    storage.create(base("demo"))
    await storage.extractCode("demo", zipSync(artifact, { level: 6 }))
    const codeZip = await storage.zipCode("demo")
    const entries = Object.keys(unzipSync(codeZip!))
    expect(entries.filter((e) => e.includes("pb_data"))).toEqual([])
  })

  test("toLocalPath maps the three server prefixes back to local paths", () => {
    expect(toLocalPath("public/index.html")).toBe("index.html")
    expect(toLocalPath("public/tools/app.js")).toBe(join("tools", "app.js"))
    expect(toLocalPath("pb_migrations/1_init.js")).toBe(join(".siteio", "pb_migrations", "1_init.js"))
    expect(toLocalPath("pb_hooks/main.pb.js")).toBe(join(".siteio", "pb_hooks", "main.pb.js"))
  })
})
