import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { loadOAuthConfig, saveOAuthConfig, isOAuthConfigured } from "../../config/oauth"
import type { AgentOAuthConfig } from "../../types"

describe("Unit: OAuth Config", () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "siteio-oauth-test-"))
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  const validConfig: AgentOAuthConfig = {
    issuerUrl: "https://accounts.google.com",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    cookieSecret: "test-cookie-secret-32-chars-long!",
    cookieDomain: ".test.local",
  }

  describe("isOAuthConfigured", () => {
    test("returns true when all required fields are present", () => {
      saveOAuthConfig(testDir, validConfig)
      expect(isOAuthConfigured(testDir)).toBe(true)
    })

    test("returns false when config file does not exist", () => {
      expect(isOAuthConfigured(testDir)).toBe(false)
    })

    test("returns false when issuerUrl is missing", () => {
      const config = { ...validConfig, issuerUrl: "" }
      writeFileSync(join(testDir, "oauth-config.json"), JSON.stringify(config))
      expect(isOAuthConfigured(testDir)).toBe(false)
    })

    test("returns false when clientId is missing", () => {
      const config = { ...validConfig, clientId: "" }
      writeFileSync(join(testDir, "oauth-config.json"), JSON.stringify(config))
      expect(isOAuthConfigured(testDir)).toBe(false)
    })

    test("returns false when clientSecret is missing", () => {
      const config = { ...validConfig, clientSecret: "" }
      writeFileSync(join(testDir, "oauth-config.json"), JSON.stringify(config))
      expect(isOAuthConfigured(testDir)).toBe(false)
    })

    test("returns false when cookieSecret is missing", () => {
      const config = { ...validConfig, cookieSecret: "" }
      writeFileSync(join(testDir, "oauth-config.json"), JSON.stringify(config))
      expect(isOAuthConfigured(testDir)).toBe(false)
    })

    test("returns false when cookieDomain is missing", () => {
      const config = { ...validConfig, cookieDomain: "" }
      writeFileSync(join(testDir, "oauth-config.json"), JSON.stringify(config))
      expect(isOAuthConfigured(testDir)).toBe(false)
    })

    test("returns false when config file contains invalid JSON", () => {
      writeFileSync(join(testDir, "oauth-config.json"), "not valid json")
      expect(isOAuthConfigured(testDir)).toBe(false)
    })
  })

  describe("loadOAuthConfig", () => {
    test("loads valid config", () => {
      saveOAuthConfig(testDir, validConfig)
      const loaded = loadOAuthConfig(testDir)
      expect(loaded).toEqual(validConfig)
    })

    test("returns null for missing file", () => {
      expect(loadOAuthConfig(testDir)).toBeNull()
    })
  })

  describe("saveOAuthConfig", () => {
    test("creates directory if it does not exist", () => {
      const nestedDir = join(testDir, "nested", "path")
      saveOAuthConfig(nestedDir, validConfig)
      expect(loadOAuthConfig(nestedDir)).toEqual(validConfig)
    })
  })
})
