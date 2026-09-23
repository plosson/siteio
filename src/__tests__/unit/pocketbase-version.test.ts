// src/__tests__/unit/pocketbase-version.test.ts
import { describe, test, expect } from "bun:test"
import { POCKETBASE_VERSION, pocketbaseImage } from "../../lib/pocketbase-version.ts"

describe("Unit: pocketbase version", () => {
  test("version is a semver string", () => {
    expect(POCKETBASE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
  test("image defaults to the pinned version", () => {
    expect(pocketbaseImage()).toBe(`ghcr.io/plosson/siteio-pocketbase:${POCKETBASE_VERSION}`)
  })
  test("image follows a site's own recorded version, not the pin", () => {
    expect(pocketbaseImage("0.23.4")).toBe("ghcr.io/plosson/siteio-pocketbase:0.23.4")
  })
  test("a site with no recorded version falls back to the pin", () => {
    expect(pocketbaseImage(undefined)).toBe(pocketbaseImage())
  })
  for (const bad of ["latest", "0.23", "0.23.4; rm -rf /", "v0.23.4", "", "0.23.4-rc1", "../0.23.4"]) {
    test(`rejects a non-semver version ${JSON.stringify(bad)} instead of building an image ref from it`, () => {
      expect(() => pocketbaseImage(bad)).toThrow()
    })
  }
})
