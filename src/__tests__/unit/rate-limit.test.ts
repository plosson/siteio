import { describe, test, expect } from "bun:test"
import { RateLimiter } from "../../lib/agent/rate-limit.ts"

describe("Unit: RateLimiter", () => {
  test("blocks a key after `limit` hits in a window, then frees it", () => {
    let now = 0
    const limiter = new RateLimiter(3, 60_000, () => now)
    for (let i = 0; i < 3; i++) {
      expect(limiter.blocked("a")).toBe(false)
      limiter.hit("a")
    }
    expect(limiter.blocked("a")).toBe(true)
    expect(limiter.blocked("b")).toBe(false)
    now = 60_000
    expect(limiter.blocked("a")).toBe(false)
  })

  test("blocked() alone never counts", () => {
    const limiter = new RateLimiter(1, 60_000, () => 0)
    for (let i = 0; i < 5; i++) expect(limiter.blocked("a")).toBe(false)
  })

  test("a flood of distinct keys doesn't keep finished windows forever", () => {
    let now = 0
    const limiter = new RateLimiter(1, 1_000, () => now)
    for (let i = 0; i < 10_000; i++) limiter.hit(`ip${i}`)
    now = 2_000
    limiter.hit("fresh")
    expect(limiter.size()).toBe(1)
  })

  test("tryHit counts one and refuses once the limit is exceeded", () => {
    let now = 0
    const limiter = new RateLimiter(3, 60_000, () => now)
    expect([1, 2, 3, 4, 5].map(() => limiter.tryHit("a"))).toEqual([true, true, true, false, false])
    expect(limiter.tryHit("b")).toBe(true)
    now = 60_000
    expect(limiter.tryHit("a")).toBe(true)
  })

  test("undo gives one back, never below zero, and ignores unknown or finished windows", () => {
    let now = 0
    const limiter = new RateLimiter(2, 60_000, () => now)
    limiter.undo("nobody")
    expect(limiter.tryHit("a")).toBe(true)
    expect(limiter.tryHit("a")).toBe(true)
    limiter.undo("a")
    expect(limiter.tryHit("a")).toBe(true)
    expect(limiter.tryHit("a")).toBe(false)
    limiter.undo("a"); limiter.undo("a"); limiter.undo("a"); limiter.undo("a")
    expect(limiter.blocked("a")).toBe(false)
    expect(limiter.tryHit("a")).toBe(true)
    now = 60_000
    limiter.undo("a")
    expect(limiter.tryHit("a")).toBe(true)
  })
})
