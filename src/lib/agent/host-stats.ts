// Host metrics: once a minute, sample the CPU, memory, disk and load of the
// server the agent runs on. Samples are kept for 7 days in memory and in
// <dataDir>/host-stats.jsonl (one JSON sample per line), so a restart keeps
// the history. Best-effort: a failed sample or write is logged and skipped.
import { appendFileSync, existsSync, readFileSync, statfsSync, writeFileSync } from "fs"
import os from "os"
import { join } from "path"
import type { HostSample, HostStats, HostStatsRange } from "../../types.ts"

const INTERVAL_MS = 60_000
const RETENTION_MS = 7 * 24 * 3600_000
// The file is rewritten without expired samples about once a day.
const COMPACT_EVERY = 1440
// A 7-day history is averaged down to this many points for the API.
const MAX_POINTS = 360

export const HOST_STATS_RANGES: Record<HostStatsRange, number> = {
  "1h": 3600_000,
  "24h": 24 * 3600_000,
  "7d": RETENTION_MS,
}

interface CpuTimes {
  busy: number
  total: number
}

export function readCpuTimes(): CpuTimes {
  let busy = 0
  let total = 0
  for (const { times } of os.cpus()) {
    const sum = times.user + times.nice + times.sys + times.idle + times.irq
    total += sum
    busy += sum - times.idle
  }
  return { busy, total }
}

/** Percent of CPU time busy between two readings; 0 when the counters did not move or went back. */
export function cpuPercent(prev: CpuTimes, now: CpuTimes): number {
  const total = now.total - prev.total
  const busy = now.busy - prev.busy
  if (!(total > 0) || busy < 0) return 0
  return round1(Math.min(100, (busy / total) * 100))
}

/** Available memory. On Linux, MemAvailable counts the page cache the kernel can reclaim. */
export function availableMemory(meminfo?: string): number {
  try {
    const text = meminfo ?? readFileSync("/proc/meminfo", "utf8")
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text)
    if (m) return Number(m[1]) * 1024
  } catch {
    // Not Linux: fall back to the OS free memory.
  }
  return os.freemem()
}

/** Average consecutive samples into at most `max` points. */
export function downsample(samples: HostSample[], max: number = MAX_POINTS): HostSample[] {
  if (samples.length <= max) return samples
  const size = Math.ceil(samples.length / max)
  const out: HostSample[] = []
  for (let i = 0; i < samples.length; i += size) {
    const chunk = samples.slice(i, i + size)
    const avg = (key: keyof HostSample) => chunk.reduce((sum, s) => sum + s[key], 0) / chunk.length
    out.push({
      at: Math.round(avg("at")),
      cpu: round1(avg("cpu")),
      load1: Math.round(avg("load1") * 100) / 100,
      memUsed: Math.round(avg("memUsed")),
      memTotal: Math.round(avg("memTotal")),
      diskUsed: Math.round(avg("diskUsed")),
      diskTotal: Math.round(avg("diskTotal")),
    })
  }
  return out
}

function isSample(value: unknown): value is HostSample {
  if (!value || typeof value !== "object") return false
  const s = value as Record<string, unknown>
  return ["at", "cpu", "load1", "memUsed", "memTotal", "diskUsed", "diskTotal"].every(
    (key) => typeof s[key] === "number" && Number.isFinite(s[key])
  )
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

export class HostStatsRecorder {
  private samples: HostSample[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private prevCpu: CpuTimes = readCpuTimes()
  private appended = 0
  private readonly file: string

  constructor(
    private dataDir: string,
    private log: (line: string) => void = () => {},
    private now: () => number = Date.now
  ) {
    this.file = join(dataDir, "host-stats.jsonl")
    this.load()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Take one sample, keep it and append it to the file. */
  tick(): void {
    let sample: HostSample
    try {
      const cpuNow = readCpuTimes()
      sample = this.read(cpuNow)
      this.prevCpu = cpuNow
    } catch (err) {
      this.log(`Host stats sample failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    this.samples.push(sample)
    this.dropExpired()
    try {
      if (++this.appended >= COMPACT_EVERY) this.compact()
      else appendFileSync(this.file, JSON.stringify(sample) + "\n")
    } catch (err) {
      this.log(`Host stats write failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** A live reading plus the history of `range`. */
  stats(range: HostStatsRange): HostStats {
    const from = this.now() - HOST_STATS_RANGES[range]
    return {
      hostname: os.hostname(),
      cores: os.cpus().length,
      uptime: Math.round(os.uptime()),
      intervalSeconds: INTERVAL_MS / 1000,
      range,
      // CPU here is the average since the last sample, without moving its baseline.
      current: this.read(readCpuTimes()),
      samples: downsample(this.samples.filter((s) => s.at >= from)),
    }
  }

  private read(cpuNow: CpuTimes): HostSample {
    const memTotal = os.totalmem()
    const disk = statfsSync(this.dataDir)
    const diskTotal = disk.blocks * disk.bsize
    return {
      at: this.now(),
      cpu: cpuPercent(this.prevCpu, cpuNow),
      load1: Math.round((os.loadavg()[0] ?? 0) * 100) / 100,
      memUsed: Math.max(0, memTotal - availableMemory()),
      memTotal,
      // Space a non-root process can still use counts as free, like `df`.
      diskUsed: Math.max(0, diskTotal - disk.bavail * disk.bsize),
      diskTotal,
    }
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue
        try {
          const parsed: unknown = JSON.parse(line)
          if (isSample(parsed)) this.samples.push(parsed)
        } catch {
          // A torn last line from a crash: skip it.
        }
      }
      this.samples.sort((a, b) => a.at - b.at)
      this.dropExpired()
      this.compact()
    } catch (err) {
      this.log(`Host stats history not loaded: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private dropExpired(): void {
    const from = this.now() - RETENTION_MS
    const first = this.samples.findIndex((s) => s.at >= from)
    if (first === -1) this.samples = []
    else if (first > 0) this.samples = this.samples.slice(first)
  }

  private compact(): void {
    this.appended = 0
    writeFileSync(this.file, this.samples.map((s) => JSON.stringify(s) + "\n").join(""))
  }
}
