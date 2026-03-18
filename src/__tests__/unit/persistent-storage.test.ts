import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { PersistentStorageManager } from "../../lib/agent/persistent-storage.ts"

describe("Unit: PersistentStorageManager", () => {
  const TEST_DATA_DIR = join(import.meta.dir, ".test-data-persistent-storage")
  let manager: PersistentStorageManager

  beforeEach(() => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
    mkdirSync(TEST_DATA_DIR, { recursive: true })
    manager = new PersistentStorageManager(TEST_DATA_DIR)
  })

  afterEach(() => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
  })

  test("get() returns null for non-existent storage", () => {
    expect(manager.get("nosite")).toBeNull()
  })

  test("set() then get() roundtrips data", () => {
    manager.set("mysite", { key1: "value1", key2: "value2" })
    const data = manager.get("mysite")
    expect(data).toEqual({ key1: "value1", key2: "value2" })
  })

  test("set() overwrites existing data", () => {
    manager.set("mysite", { old: "data" })
    manager.set("mysite", { new: "data" })
    expect(manager.get("mysite")).toEqual({ new: "data" })
  })

  test("set() enforces 1MB size limit", () => {
    const largeData: Record<string, string> = {
      big: "x".repeat(1024 * 1024 + 1),
    }
    expect(() => manager.set("mysite", largeData)).toThrow("exceeds limit")
  })

  test("set() allows data just under 1MB", () => {
    const data: Record<string, string> = {
      big: "x".repeat(1024 * 1024 - 100),
    }
    expect(() => manager.set("mysite", data)).not.toThrow()
  })

  test("deleteSite() removes all storage for a site", () => {
    manager.set("mysite", { key: "value" })
    manager.set("mysite", { key: "value2" }, "user@example.com")
    manager.deleteSite("mysite")
    expect(manager.get("mysite")).toBeNull()
    expect(manager.get("mysite", "user@example.com")).toBeNull()
    expect(existsSync(join(TEST_DATA_DIR, "persistent-storage", "mysite"))).toBe(false)
  })

  test("deleteSite() is safe for non-existent site", () => {
    expect(() => manager.deleteSite("nosite")).not.toThrow()
  })

  describe("per-user isolation", () => {
    test("different emails get different storage", () => {
      manager.set("mysite", { user: "alice" }, "alice@example.com")
      manager.set("mysite", { user: "bob" }, "bob@example.com")

      expect(manager.get("mysite", "alice@example.com")).toEqual({ user: "alice" })
      expect(manager.get("mysite", "bob@example.com")).toEqual({ user: "bob" })
    })

    test("anonymous storage is separate from user storage", () => {
      manager.set("mysite", { anonymous: "true" })
      manager.set("mysite", { user: "alice" }, "alice@example.com")

      expect(manager.get("mysite")).toEqual({ anonymous: "true" })
      expect(manager.get("mysite", "alice@example.com")).toEqual({ user: "alice" })
    })

    test("email is case-insensitive", () => {
      manager.set("mysite", { user: "alice" }, "Alice@Example.COM")
      expect(manager.get("mysite", "alice@example.com")).toEqual({ user: "alice" })
    })
  })
})
