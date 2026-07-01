import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { PocketStorage } from "../../lib/agent/pocket-storage.ts"
import type { Pocket } from "../../types.ts"

describe("Unit: PocketStorage", () => {
  let dir: string
  let storage: PocketStorage
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "siteio-ps-"))
    storage = new PocketStorage(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const base = (name: string): Omit<Pocket, "createdAt" | "updatedAt"> => ({
    name,
    domains: [`${name}.example.com`],
    pocketbaseVersion: "0.23.4",
    status: "pending",
    size: 0,
  })

  test("creates and reads a pocket", () => {
    storage.create(base("blog"))
    const p = storage.get("blog")
    expect(p).not.toBeNull()
    expect(p!.pocketbaseVersion).toBe("0.23.4")
    expect(p!.createdAt).toBeDefined()
  })

  test("rejects reserved and invalid names", () => {
    expect(() => storage.create(base("api"))).toThrow()
    expect(() => storage.create(base("Bad Name"))).toThrow()
  })

  test("extractCode writes files and bumps version", async () => {
    storage.create(base("blog"))
    const zip = zipSync({ "public/index.html": new TextEncoder().encode("<h1>hi</h1>") })
    const first = await storage.extractCode("blog", zip)
    expect(first.version).toBe(1)
    expect(first.size).toBeGreaterThan(0)
    expect(existsSync(join(storage.getCodePath("blog"), "public", "index.html"))).toBe(true)

    const second = await storage.extractCode("blog", zip)
    expect(second.version).toBe(2)
  })

  test("extractCode rejects path traversal entries", async () => {
    storage.create(base("blog"))
    const evil = zipSync({ "../escape.txt": new TextEncoder().encode("x") })
    await expect(storage.extractCode("blog", evil)).rejects.toThrow()
  })

  test("delete removes metadata, code and data", async () => {
    storage.create(base("blog"))
    const zip = zipSync({ "public/index.html": new TextEncoder().encode("x") })
    await storage.extractCode("blog", zip)
    expect(storage.delete("blog")).toBe(true)
    expect(storage.get("blog")).toBeNull()
    expect(existsSync(storage.getCodePath("blog"))).toBe(false)
    expect(existsSync(storage.getDataPath("blog"))).toBe(false)
  })

  test("toInfo strips secrets and exposes admin url", () => {
    const p = storage.create({
      ...base("blog"),
      superuserEmail: "a@b.co",
      superuserPassword: "secret",
      google: { clientId: "id", clientSecret: "sec" },
    })
    const info = storage.toInfo(p, "example.com")
    expect(info.url).toBe("https://blog.example.com")
    expect(info.adminUrl).toBe("https://blog.example.com/_/")
    const raw = info as unknown as { superuserPassword?: string; superuserEmail?: string; google?: unknown }
    expect(raw.superuserPassword).toBeUndefined()
    expect(raw.superuserEmail).toBeUndefined()
    expect(raw.google).toBeUndefined()
  })

  test("writeOAuthHelper writes a valid public/pocket-oauth.js with injected values", async () => {
    storage.create(base("blog"))
    await storage.extractCode("blog", zipSync({ "public/index.html": new TextEncoder().encode("x") }))
    storage.writeOAuthHelper("blog", "example.com")

    const helperPath = join(storage.getCodePath("blog"), "public", "pocket-oauth.js")
    expect(existsSync(helperPath)).toBe(true)
    const js = readFileSync(helperPath, "utf-8")

    // Injected, not left as placeholders
    expect(js).not.toContain("__POCKET_NAME__")
    expect(js).toContain('var POCKET = "blog"')
    expect(js).toContain('var API_BASE = "https://api.example.com"')
    expect(js).toContain("window.pocketLogin")
    expect(js).toContain("/pocket/oauth/callback")
    // The generated script is syntactically valid JavaScript
    expect(() => new Function(js)).not.toThrow()
  })
})
