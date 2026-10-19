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
})
