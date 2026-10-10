import { describe, expect, test } from "bun:test"
import { AnalyticsPump, type PumpDeps } from "../../lib/agent/analytics/pump"
import type { AnalyticsBatch } from "../../types"

const line = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    StartUTC: "2026-10-10T12:00:03Z",
    RouterName: "siteio-blog@docker",
    RequestMethod: "GET",
    RequestHost: "blog.chuut.com",
    RequestPath: "/",
    DownstreamStatus: 200,
    DownstreamContentSize: 10,
    Duration: 1_000_000,
    ClientHost: "203.0.113.9",
    "request_User-Agent": "Mozilla/5.0 Firefox/130.0",
    "downstream_Content-Type": "text/html",
    ...over,
  })

// A tailer that hands out pre-baked chunks.
function chunks(...cs: string[][]): PumpDeps["tailer"] {
  return {
    readChunk: () => {
      const lines = cs.shift() ?? []
      return { lines, more: cs.length > 0 }
    },
  }
}

function deps(over: Partial<PumpDeps> = {}) {
  const sent: AnalyticsBatch[] = []
  const logs: string[] = []
  const d: PumpDeps = {
    agent: "chuut.com",
    tailer: chunks([line()]),
    resolve: (key) => (key === "blog" ? { kind: "site", name: "blog" } : null),
    send: async (b) => {
      sent.push(b)
    },
    log: (l) => logs.push(l),
    ...over,
  }
  return { d, sent, logs }
}

describe("AnalyticsPump", () => {
  test("one tick sends one batch per chunk", async () => {
    const { d, sent } = deps({ tailer: chunks([line()], [line(), line()]) })
    await new AnalyticsPump(d).tick()
    expect(sent.map((b) => b.traffic[0]!.requests)).toEqual([1, 2])
  })

  test("nothing new → nothing sent", async () => {
    const { d, sent } = deps({ tailer: chunks([]) })
    await new AnalyticsPump(d).tick()
    expect(sent).toHaveLength(0)
  })

  test("garbage lines are skipped; the valid ones in the same chunk still go out", async () => {
    const { d, sent } = deps({ tailer: chunks(["{broken", "", line(), "null"]) })
    await new AnalyticsPump(d).tick()
    expect(sent[0]!.traffic[0]!.requests).toBe(1)
  })

  test("a failing endpoint is logged and the batch dropped; the next chunk still goes out", async () => {
    let calls = 0
    const sent: AnalyticsBatch[] = []
    const { d, logs } = deps({
      tailer: chunks([line()], [line()]),
      send: async (b) => {
        if (calls++ === 0) throw new Error("ECONNREFUSED")
        sent.push(b)
      },
    })
    await new AnalyticsPump(d).tick()
    expect(sent).toHaveLength(1)
    expect(logs.some((l) => l.includes("ECONNREFUSED"))).toBe(true)
  })

  test("a throwing tailer (disk error) is logged, not thrown", async () => {
    const { d, logs } = deps({
      tailer: {
        readChunk: () => {
          throw new Error("EACCES")
        },
      },
    })
    await new AnalyticsPump(d).tick()
    expect(logs.some((l) => l.includes("EACCES"))).toBe(true)
  })

  test("ticks never overlap while a send hangs", async () => {
    let release!: () => void
    let sends = 0
    const { d } = deps({
      tailer: { readChunk: () => ({ lines: [line()], more: false }) },
      send: () => {
        sends++
        return new Promise<void>((r) => (release = r))
      },
    })
    const pump = new AnalyticsPump(d)
    const first = pump.tick()
    await pump.tick() // returns at once: a tick is already running
    expect(sends).toBe(1)
    release()
    await first
  })

  test("a tailer that always says more is cut off after a bounded number of chunks", async () => {
    let reads = 0
    const { d } = deps({
      tailer: {
        readChunk: () => {
          reads++
          return { lines: [line()], more: true }
        },
      },
    })
    await new AnalyticsPump(d).tick()
    expect(reads).toBeLessThanOrEqual(50)
  })
})
