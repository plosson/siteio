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
    })
    const info = storage.toInfo(p, "example.com")
    expect(info.url).toBe("https://blog.example.com")
    expect(info.adminUrl).toBe("https://blog.example.com/_/")
    const raw = info as unknown as { superuserPassword?: string; superuserEmail?: string }
    expect(raw.superuserPassword).toBeUndefined()
    expect(raw.superuserEmail).toBeUndefined()
  })

  test("toInfo filters the legacy default-subdomain entry out of domains", () => {
    // Older deploys stored the default subdomain inside `domains`
    const p = storage.create({ ...base("blog"), domains: ["blog.example.com", "custom.org"] })
    const info = storage.toInfo(p, "example.com")
    expect(info.domains).toEqual(["custom.org"])
    expect(storage.allDomains(p, "example.com")).toEqual(["blog.example.com", "custom.org"])
  })

  test("history keeps at most 10 versions and prunes v<N>.json alongside", async () => {
    storage.create({ ...base("blog"), domains: [] })
    for (let i = 1; i <= 12; i++) {
      const zip = zipSync({ "public/index.html": new TextEncoder().encode(`v${i}`) })
      const { version } = await storage.extractCode("blog", zip)
      storage.update("blog", { version, size: i, deployedAt: new Date().toISOString() })
    }
    const history = storage.getHistory("blog")
    expect(history).toHaveLength(10)
    expect(history[0]!.version).toBe(11)
    expect(history[9]!.version).toBe(2)
    // Pruned versions leave no orphan metadata
    expect(existsSync(join(dir, "pocket-history", "blog", "v1.json"))).toBe(false)
    expect(existsSync(join(dir, "pocket-history", "blog", "v1"))).toBe(false)
  })

  test("restoreVersion brings back archived code without touching pb_data", async () => {
    storage.create({ ...base("blog"), domains: [] })
    const v1 = await storage.extractCode("blog", zipSync({ "public/index.html": new TextEncoder().encode("one") }))
    storage.update("blog", { version: v1.version, size: 3 })
    const v2 = await storage.extractCode("blog", zipSync({ "public/index.html": new TextEncoder().encode("two") }))
    storage.update("blog", { version: v2.version, size: 3 })

    const restored = storage.restoreVersion("blog", 1)
    expect(restored).not.toBeNull()
    expect(restored!.version).toBe(3)
    const content = readFileSync(join(storage.getCodePath("blog"), "public", "index.html"), "utf-8")
    expect(content).toBe("one")

    expect(storage.restoreVersion("blog", 99)).toBeNull()
  })

  test("rename moves metadata, code, data, and history", async () => {
    storage.create({ ...base("blog"), domains: ["custom.org"] })
    await storage.extractCode("blog", zipSync({ "public/index.html": new TextEncoder().encode("one") }))
    await storage.extractCode("blog", zipSync({ "public/index.html": new TextEncoder().encode("two") }))

    const renamed = storage.rename("blog", "journal")
    expect(renamed!.name).toBe("journal")
    expect(renamed!.domains).toEqual(["custom.org"])
    expect(storage.get("blog")).toBeNull()
    expect(existsSync(join(storage.getCodePath("journal"), "public", "index.html"))).toBe(true)
    expect(storage.getHistory("journal")).toHaveLength(1)
    expect(() => storage.rename("journal", "api")).toThrow()
  })
})
