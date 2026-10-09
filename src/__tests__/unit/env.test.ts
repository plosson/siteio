// src/__tests__/unit/env.test.ts
import { describe, test, expect } from "bun:test"
import { applyEnvUpdate, publicEnv } from "../../lib/agent/env.ts"

describe("applyEnvUpdate", () => {
  test("merges additively and marks only secrets", () => {
    const out = applyEnvUpdate({ env: { A: "1" } }, { env: { B: "2" }, secrets: { S: "x" } }, "sites")
    expect(out).toEqual({ env: { A: "1", B: "2", S: "x" }, secretKeys: ["S"] })
  })

  test("has no secretKeys property when nothing is secret", () => {
    const out = applyEnvUpdate({}, { env: { A: "1" } }, "sites")
    expect(out).toEqual({ env: { A: "1" } })
    expect("secretKeys" in out).toBe(false)
  })

  test("refuses to turn a secret back into a plain var, naming the right command", () => {
    expect(() => applyEnvUpdate({ env: { S: "x" }, secretKeys: ["S"] }, { env: { S: "y" } }, "sites")).toThrow(
      "'S' is a secret. Set it with --secret S=<value>, or remove it first with 'sites unset -e S'"
    )
    expect(() => applyEnvUpdate({ env: { S: "x" }, secretKeys: ["S"] }, { env: { S: "y" } }, "apps")).toThrow("'apps unset -e S'")
  })

  test("the refusal never echoes the attempted value", () => {
    try {
      applyEnvUpdate({ env: { S: "x" }, secretKeys: ["S"] }, { env: { S: "leaky-value" } }, "sites")
    } catch (err) {
      expect((err as Error).message).not.toContain("leaky-value")
    }
  })

  test("a secret may replace a plain var and is listed once", () => {
    const out = applyEnvUpdate({ env: { S: "plain" }, secretKeys: ["S"] }, { secrets: { S: "new" } }, "sites")
    expect(out).toEqual({ env: { S: "new" }, secretKeys: ["S"] })
  })

  test("unset removes value and marking, and unknown keys are ignored", () => {
    const out = applyEnvUpdate({ env: { S: "x", A: "1" }, secretKeys: ["S"] }, { unsetEnv: ["S", "NOPE"] }, "sites")
    expect(out).toEqual({ env: { A: "1" } })
  })

  test("does not mutate its input", () => {
    const current = { env: { A: "1" }, secretKeys: ["A"] }
    applyEnvUpdate(current, { unsetEnv: ["A"] }, "sites")
    expect(current).toEqual({ env: { A: "1" }, secretKeys: ["A"] })
  })
})

describe("publicEnv", () => {
  test("drops every secret value", () => {
    expect(publicEnv({ env: { A: "1", S: "x" }, secretKeys: ["S"] })).toEqual({ A: "1" })
    expect(publicEnv({})).toEqual({})
  })
})
