// Reads Traefik's access log incrementally. One byte offset, persisted next to
// the log, applies to `<path>.1` while a rotated file exists, else to `<path>`.
// Rotation is rename + reopen (Traefik reopens its log on USR1); the old file
// is deleted only once fully read and quiet, so late lines are not lost.
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "fs"

export interface TailerOptions {
  path: string
  reopen: () => void
  maxBytes?: number
  chunkBytes?: number
  settleMs?: number
  now?: () => number
}

const MAX_BYTES = 20 * 1024 * 1024
const CHUNK_BYTES = 4 * 1024 * 1024
const SETTLE_MS = 5000

export class AccessLogTailer {
  private path: string
  private rotated: string
  private statePath: string
  private reopen: () => void
  private maxBytes: number
  private chunkBytes: number
  private settleMs: number
  private now: () => number
  // Inside a line longer than one chunk: drop bytes up to its newline. In
  // memory only; after a restart the leftover tail is one unparseable line.
  private skipping = false

  constructor(opts: TailerOptions) {
    this.path = opts.path
    this.rotated = `${opts.path}.1`
    this.statePath = `${opts.path}.offset`
    this.reopen = opts.reopen
    this.maxBytes = opts.maxBytes ?? MAX_BYTES
    this.chunkBytes = opts.chunkBytes ?? CHUNK_BYTES
    this.settleMs = opts.settleMs ?? SETTLE_MS
    this.now = opts.now ?? Date.now
  }

  readChunk(): { lines: string[]; more: boolean } {
    const draining = existsSync(this.rotated)
    const file = draining ? this.rotated : this.path
    if (!existsSync(file)) return { lines: [], more: false }

    const { size, mtimeMs } = statSync(file)
    let offset = this.loadOffset()
    if (offset > size) offset = 0

    const { lines, consumed } = this.read(file, offset, size)
    offset += consumed
    this.saveOffset(offset)

    if (draining) {
      // consumed === 0 with bytes left: a cut-off last line that will never end.
      if (offset < size && consumed > 0) return { lines, more: true }
      // Fully read: drop it once Traefik has clearly moved on to the new file.
      // mtimeMs has sub-ms precision, now() whole ms: floor to avoid a spurious "future" mtime.
      if (this.now() - Math.floor(mtimeMs) < this.settleMs) return { lines, more: false }
      rmSync(this.rotated, { force: true })
      this.saveOffset(0)
      return { lines, more: existsSync(this.path) }
    }

    if (offset >= this.maxBytes) {
      renameSync(this.path, this.rotated)
      this.reopen()
      return { lines, more: true }
    }
    return { lines, more: consumed > 0 && offset < size }
  }

  // Complete lines from `offset`, at most one chunk. A chunk with no newline
  // that fills the whole chunk is one oversized line: skip it.
  private read(file: string, offset: number, size: number): { lines: string[]; consumed: number } {
    const length = Math.min(this.chunkBytes, size - offset)
    if (length <= 0) return { lines: [], consumed: 0 }
    const buf = Buffer.alloc(length)
    const fd = openSync(file, "r")
    try {
      readSync(fd, buf, 0, length, offset)
    } finally {
      closeSync(fd)
    }
    let start = 0
    if (this.skipping) {
      const nl = buf.indexOf(0x0a)
      if (nl === -1) return { lines: [], consumed: length }
      this.skipping = false
      start = nl + 1
    }
    const end = buf.lastIndexOf(0x0a)
    if (end < start) {
      // No complete line yet. A whole chunk of one line: start skipping it.
      if (start === 0 && length === this.chunkBytes) {
        this.skipping = true
        return { lines: [], consumed: length }
      }
      return { lines: [], consumed: start }
    }
    const lines = buf
      .subarray(start, end)
      .toString("utf-8")
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.trim() !== "")
    return { lines, consumed: end + 1 }
  }

  private loadOffset(): number {
    try {
      const n = Number(readFileSync(this.statePath, "utf-8").trim())
      return Number.isSafeInteger(n) && n >= 0 ? n : 0
    } catch {
      return 0
    }
  }

  private saveOffset(offset: number): void {
    writeFileSync(this.statePath, String(offset))
  }
}
