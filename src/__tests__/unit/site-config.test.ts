import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { loadProjectConfig, saveProjectConfig, resolveSubdomain, resolveAppName } from "../../utils/site-config.ts"

describe("Unit: Site Config", () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "siteio-config-test-"))
  })

  afterAll(() => {
    // Clean up all temp dirs (best effort)
  })

  describe("loadProjectConfig", () => {
    test("returns null when no config exists", () => {
      const config = loadProjectConfig(testDir)
      expect(config).toBeNull()
    })

    test("loads site config from .siteio/config.json", () => {
      saveProjectConfig({ site: "mysite", domain: "example.com" }, testDir)
      const config = loadProjectConfig(testDir)
      expect(config).toEqual({ site: "mysite", domain: "example.com" })
    })

    test("loads app config from .siteio/config.json", () => {
      saveProjectConfig({ app: "myapp", domain: "example.com" }, testDir)
      const config = loadProjectConfig(testDir)
      expect(config).toEqual({ app: "myapp", domain: "example.com" })
    })

    test("returns null for malformed JSON", () => {
      const { mkdirSync, writeFileSync } = require("fs")
      mkdirSync(join(testDir, ".siteio"), { recursive: true })
      writeFileSync(join(testDir, ".siteio", "config.json"), "not json{{{")
      const config = loadProjectConfig(testDir)
      expect(config).toBeNull()
    })
  })

  describe("saveProjectConfig", () => {
    test("creates .siteio directory and config file", () => {
      saveProjectConfig({ site: "test", domain: "example.com" }, testDir)
      const configPath = join(testDir, ".siteio", "config.json")
      expect(existsSync(configPath)).toBe(true)
      const content = JSON.parse(readFileSync(configPath, "utf-8"))
      expect(content).toEqual({ site: "test", domain: "example.com" })
    })

    test("overwrites existing config", () => {
      saveProjectConfig({ site: "first", domain: "a.com" }, testDir)
      saveProjectConfig({ site: "second", domain: "b.com" }, testDir)
      const config = loadProjectConfig(testDir)
      expect(config).toEqual({ site: "second", domain: "b.com" })
    })

    test("writes trailing newline", () => {
      saveProjectConfig({ site: "test", domain: "example.com" }, testDir)
      const raw = readFileSync(join(testDir, ".siteio", "config.json"), "utf-8")
      expect(raw.endsWith("\n")).toBe(true)
    })
  })

  describe("resolveSubdomain", () => {
    test("returns explicit value when provided", () => {
      const result = resolveSubdomain("explicit", "example.com", testDir)
      expect(result).toBe("explicit")
    })

    test("returns explicit value even when config exists", () => {
      saveProjectConfig({ site: "fromconfig", domain: "example.com" }, testDir)
      const result = resolveSubdomain("explicit", "example.com", testDir)
      expect(result).toBe("explicit")
    })

    test("falls back to config when no explicit value", () => {
      saveProjectConfig({ site: "fromconfig", domain: "example.com" }, testDir)
      const result = resolveSubdomain(undefined, "example.com", testDir)
      expect(result).toBe("fromconfig")
    })

    test("returns null when no explicit value and no config", () => {
      const result = resolveSubdomain(undefined, "example.com", testDir)
      expect(result).toBeNull()
    })

    test("returns null when config domain does not match server", () => {
      saveProjectConfig({ site: "fromconfig", domain: "other.com" }, testDir)
      const result = resolveSubdomain(undefined, "example.com", testDir)
      expect(result).toBeNull()
    })

    test("returns null when config has app but not site", () => {
      saveProjectConfig({ app: "myapp", domain: "example.com" }, testDir)
      const result = resolveSubdomain(undefined, "example.com", testDir)
      expect(result).toBeNull()
    })
  })

  describe("resolveAppName", () => {
    test("returns explicit value when provided", () => {
      const result = resolveAppName("explicit", "example.com", testDir)
      expect(result).toBe("explicit")
    })

    test("returns explicit value even when config exists", () => {
      saveProjectConfig({ app: "fromconfig", domain: "example.com" }, testDir)
      const result = resolveAppName("explicit", "example.com", testDir)
      expect(result).toBe("explicit")
    })

    test("falls back to config when no explicit value", () => {
      saveProjectConfig({ app: "fromconfig", domain: "example.com" }, testDir)
      const result = resolveAppName(undefined, "example.com", testDir)
      expect(result).toBe("fromconfig")
    })

    test("returns null when no explicit value and no config", () => {
      const result = resolveAppName(undefined, "example.com", testDir)
      expect(result).toBeNull()
    })

    test("returns null when config domain does not match server", () => {
      saveProjectConfig({ app: "fromconfig", domain: "other.com" }, testDir)
      const result = resolveAppName(undefined, "example.com", testDir)
      expect(result).toBeNull()
    })

    test("returns null when config has site but not app", () => {
      saveProjectConfig({ site: "mysite", domain: "example.com" }, testDir)
      const result = resolveAppName(undefined, "example.com", testDir)
      expect(result).toBeNull()
    })
  })
})
