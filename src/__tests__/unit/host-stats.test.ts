import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { HostStatsRecorder, availableMemory, cpuPercent, downsample } from "../../lib/agent/host-stats.ts"
import type { HostSample } from "../../types.ts"

const NOW = 1_800_000_000_000
const MIN = 60_000
const sample = (at: number, cpu = 10): HostSample => ({
  at, cpu, load1: 0.5, memUsed: 100, memTotal: 1000, diskUsed: 200, diskTotal: 2000,
})

describe("cpuPercent", () => {
  test("counters that did not move give 0, not NaN", () => {
    expect(cpuPercent({ busy: 5, total: 10 }, { busy: 5, total: 10 })).toBe(0)
  })

  test("counters that went back (wrap, hotplug) give 0, not a negative", () => {
    expect(cpuPercent({ busy: 50, total: 100 }, { busy: 10, total: 200 })).toBe(0)
    expect(cpuPercent({ busy: 50, total: 100 }, { busy: 60, total: 90 })).toBe(0)
  })

  test("never goes above 100", () => {
    expect(cpuPercent({ busy: 0, total: 0 }, { busy: 300, total: 100 })).toBe(100)
  })

  test("is the busy share of the elapsed time", () => {
    expect(cpuPercent({ busy: 0, total: 0 }, { busy: 25, total: 100 })).toBe(25)
  })
})

describe("availableMemory", () => {
  test("reads MemAvailable in kB", () => {
    expect(availableMemory("MemTotal: 2048 kB\nMemFree: 10 kB\nMemAvailable:    1024 kB\n")).toBe(1024 * 1024)
  })

  test("a meminfo without MemAvailable falls back to a real number", () => {
    const n = availableMemory("MemTotal: 2048 kB\nMemFree: garbage\n")
    expect(Number.isFinite(n)).toBe(true)
    expect(n).toBeGreaterThan(0)
  })

  test("does not pick MemAvailable from the middle of another line", () => {
    const n = availableMemory("XMemAvailable: 1 kB\n")
    expect(n).not.toBe(1024)
  })
})

describe("downsample", () => {
  test("leaves short series and empty series alone", () => {
    expect(downsample([])).toEqual([])
    const s = [sample(1), sample(2)]
    expect(downsample(s, 2)).toBe(s)
  })

  test("one sample over the limit still fits the limit", () => {
    const s = Array.from({ length: 361 }, (_, i) => sample(i * MIN))
    expect(downsample(s, 360).length).toBeLessThanOrEqual(360)
  })

  test("averages each bucket, including an uneven last bucket", () => {
    const s = [sample(0, 0), sample(MIN, 100), sample(2 * MIN, 50)]
    expect(downsample(s, 2)).toEqual([
      { ...sample(MIN / 2, 50) },
      { ...sample(2 * MIN, 50) },
    ])
  })
})

describe("HostStatsRecorder", () => {
  let dataDir: string
  let file: string
  let logs: string[]
  let now: number
  const make = () => new HostStatsRecorder(dataDir, (l) => logs.push(l), () => now)

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-host-stats-"))
    file = join(dataDir, "host-stats.jsonl")
    logs = []
    now = NOW
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  test("no history file: empty history, a live reading", () => {
    const stats = make().stats("24h")
    expect(stats.samples).toEqual([])
    expect(stats.current.at).toBe(NOW)
    expect(stats.current.memTotal).toBeGreaterThan(0)
    expect(stats.current.diskTotal).toBeGreaterThan(0)
    expect(stats.current.memUsed).toBeLessThanOrEqual(stats.current.memTotal)
    expect(stats.current.diskUsed).toBeLessThanOrEqual(stats.current.diskTotal)
    expect(existsSync(file)).toBe(false)
  })

  test("skips torn, malformed and non-numeric lines and keeps the good ones", () => {
    writeFileSync(file, [
      JSON.stringify(sample(NOW - 2 * MIN)),
      "{not json",
      JSON.stringify({ ...sample(NOW - MIN), cpu: "50" }),
      JSON.stringify({ ...sample(NOW - MIN), memUsed: null }),
      "null",
      "42",
      JSON.stringify([1, 2]),
      JSON.stringify(sample(NOW - MIN)),
      '{"at":' + (NOW - 30_000),
    ].join("\n"))
    const stats = make().stats("1h")
    expect(stats.samples.map((s) => s.at)).toEqual([NOW - 2 * MIN, NOW - MIN])
    // The file is rewritten clean.
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2)
  })

  test("drops samples older than 7 days on load and sorts out-of-order lines", () => {
    writeFileSync(file, [
      sample(NOW - 8 * 24 * 60 * MIN),
      sample(NOW - MIN),
      sample(NOW - 3 * MIN),
    ].map((s) => JSON.stringify(s)).join("\n") + "\n")
    const stats = make().stats("7d")
    expect(stats.samples.map((s) => s.at)).toEqual([NOW - 3 * MIN, NOW - MIN])
  })

  test("a sample in the future of the range is not lost and the range filter holds", () => {
    writeFileSync(file, [sample(NOW - 2 * 3600_000), sample(NOW - 30 * MIN)].map((s) => JSON.stringify(s)).join("\n"))
    const r = make()
    expect(r.stats("1h").samples.map((s) => s.at)).toEqual([NOW - 30 * MIN])
    expect(r.stats("24h").samples).toHaveLength(2)
  })

  test("tick appends a sample that survives a restart", () => {
    const r = make()
    r.tick()
    now += MIN
    r.tick()
    expect(r.stats("1h").samples).toHaveLength(2)
    const again = make()
    expect(again.stats("1h").samples.map((s) => s.at)).toEqual([NOW, NOW + MIN])
  })

  test("a history path that is a directory is logged, not thrown, and samples stay in memory", () => {
    mkdirSync(file)
    const r = make()
    expect(logs.some((l) => l.includes("not loaded"))).toBe(true)
    r.tick()
    expect(logs.some((l) => l.includes("write failed"))).toBe(true)
    expect(r.stats("1h").samples).toHaveLength(1)
  })

  test("a data dir that disappears makes a tick log instead of throwing", () => {
    const r = make()
    rmSync(dataDir, { recursive: true, force: true })
    expect(() => r.tick()).not.toThrow()
    expect(logs.some((l) => l.includes("sample failed"))).toBe(true)
    expect(r.stats.bind(r, "1h")).toThrow()
  })
})
