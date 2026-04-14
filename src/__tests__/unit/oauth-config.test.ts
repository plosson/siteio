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

  describe("endSessionEndpoint persistence", () => {
    test("persists endSessionEndpoint when present", () => {
      const config: AgentOAuthConfig = {
        ...validConfig,
        endSessionEndpoint: "https://tenant.auth0.com/oidc/logout",
      }
      saveOAuthConfig(testDir, config)
      expect(loadOAuthConfig(testDir)).toEqual(config)
    })

    test("loads legacy config without endSessionEndpoint", () => {
      saveOAuthConfig(testDir, validConfig)
      const loaded = loadOAuthConfig(testDir)
      expect(loaded?.endSessionEndpoint).toBeUndefined()
    })
  })

  describe("ensureDiscoveredConfig", () => {
    const originalFetch = globalThis.fetch

    afterEach(() => {
      globalThis.fetch = originalFetch
    })

    test("runs discovery and persists endSessionEndpoint when missing", async () => {
      saveOAuthConfig(testDir, validConfig) // legacy, no endSessionEndpoint, no discoveredAt
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            issuer: "https://accounts.google.com",
            // no end_session_endpoint
          }),
          { status: 200 }
        )) as unknown as typeof fetch

      const { ensureDiscoveredConfig } = await import("../../config/oauth")
      const updated = await ensureDiscoveredConfig(testDir)
      expect(updated?.endSessionEndpoint).toBeUndefined()

      // discoveredAt should be set as ISO timestamp so we don't re-fetch on every boot.
      const reloaded = loadOAuthConfig(testDir)
      expect(reloaded?.discoveredAt).toBeTruthy()
      expect(typeof reloaded?.discoveredAt).toBe("string")
    })

    test("skips discovery when discoveredAt is already set", async () => {
      const migrated: AgentOAuthConfig = {
        ...validConfig,
        endSessionEndpoint: "https://tenant.auth0.com/oidc/logout",
        discoveredAt: "2026-04-14T10:00:00.000Z",
      }
      saveOAuthConfig(testDir, migrated)
      let fetchCalled = false
      globalThis.fetch = (async () => {
        fetchCalled = true
        return new Response("{}", { status: 200 })
      }) as unknown as typeof fetch

      const { ensureDiscoveredConfig } = await import("../../config/oauth")
      const result = await ensureDiscoveredConfig(testDir)
      expect(result).toEqual(migrated)
      expect(fetchCalled).toBe(false)
    })

    test("returns null when no config file exists", async () => {
      const { ensureDiscoveredConfig } = await import("../../config/oauth")
      expect(await ensureDiscoveredConfig(testDir)).toBeNull()
    })
  })
})
