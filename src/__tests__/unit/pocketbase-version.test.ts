// src/__tests__/unit/pocketbase-version.test.ts
import { describe, test, expect } from "bun:test"
import { POCKETBASE_VERSION, POCKETBASE_IMAGE } from "../../lib/pocketbase-version.ts"

describe("Unit: pocketbase version constants", () => {
  test("version is a semver string", () => {
    expect(POCKETBASE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
  test("image reference pins the same version", () => {
    expect(POCKETBASE_IMAGE.endsWith(`:${POCKETBASE_VERSION}`)).toBe(true)
  })
})
