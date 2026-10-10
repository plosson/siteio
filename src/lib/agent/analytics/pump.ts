// Every interval: drain the access log in chunks, turn each chunk into a batch,
// send it. Best-effort: a failed batch is logged and dropped. Ticks never overlap.
import type { AnalyticsBatch } from "../../../types.ts"
import { buildBatch, type Resolve } from "./batch.ts"
import { parseEntry, type AccessLogEntry } from "./classify.ts"
import type { AccessLogTailer } from "./tailer.ts"

export interface PumpDeps {
  agent: string
  tailer: Pick<AccessLogTailer, "readChunk">
  resolve: Resolve
  send: (batch: AnalyticsBatch) => Promise<void>
  log: (line: string) => void
}

const INTERVAL_MS = 60_000
// Bounds one tick (50 × 4 MiB); a backlog finishes on later ticks.
const MAX_CHUNKS_PER_TICK = 50

export class AnalyticsPump {
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false

  constructor(
    private deps: PumpDeps,
    private intervalMs: number = INTERVAL_MS
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (let i = 0; i < MAX_CHUNKS_PER_TICK; i++) {
        const { lines, more } = this.deps.tailer.readChunk()
        const entries = lines.map(parseEntry).filter((e): e is AccessLogEntry => e !== null)
        const batch = buildBatch(this.deps.agent, entries, this.deps.resolve)
        if (batch) {
          try {
            await this.deps.send(batch)
          } catch (err) {
            this.deps.log(`Analytics batch dropped: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        if (!more) break
      }
    } catch (err) {
      this.deps.log(`Analytics tick failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.running = false
    }
  }
}
