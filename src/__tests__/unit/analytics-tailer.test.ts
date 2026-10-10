import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AccessLogTailer, type TailerOptions } from "../../lib/agent/analytics/tailer"

let dir: string
let path: string
let reopens: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "siteio-tailer-"))
  path = join(dir, "access.log")
  reopens = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const make = (over: Partial<TailerOptions> = {}) =>
  new AccessLogTailer({ path, reopen: () => reopens++, settleMs: 0, ...over })

// Drain everything the tailer will give right now.
function drain(t: AccessLogTailer): string[] {
  const out: string[] = []
  for (let i = 0; i < 1000; i++) {
    const { lines, more } = t.readChunk()
    out.push(...lines)
    if (!more) return out
  }
  throw new Error("tailer never reported caught up")
}

describe("AccessLogTailer", () => {
  test("missing file → nothing, no crash", () => {
    expect(make().readChunk()).toEqual({ lines: [], more: false })
  })

  test("reads complete lines once, then only new ones", () => {
    writeFileSync(path, "a\nb\n")
    const t = make()
    expect(drain(t)).toEqual(["a", "b"])
    expect(drain(t)).toEqual([])
    appendFileSync(path, "c\n")
    expect(drain(t)).toEqual(["c"])
  })

  test("a half-written last line is held back until its newline arrives", () => {
    writeFileSync(path, 'a\n{"half":')
    const t = make()
    expect(drain(t)).toEqual(["a"])
    appendFileSync(path, "true}\n")
    expect(drain(t)).toEqual(['{"half":true}'])
  })

  test("the offset survives a restart (new tailer instance)", () => {
    writeFileSync(path, "a\n")
    drain(make())
    appendFileSync(path, "b\n")
    expect(drain(make())).toEqual(["b"])
  })

  test("a corrupt offset file restarts from 0 instead of crashing", () => {
    writeFileSync(path, "a\n")
    writeFileSync(`${path}.offset`, "not a number")
    expect(drain(make())).toEqual(["a"])
  })

  test("a truncated file is re-read from the start", () => {
    writeFileSync(path, "aaaa\nbbbb\n")
    const t = make()
    drain(t)
    writeFileSync(path, "c\n")
    expect(drain(t)).toEqual(["c"])
  })

  test("blank lines and CRLF endings are not returned as entries", () => {
    writeFileSync(path, "a\r\n\n\nb\n")
    expect(drain(make())).toEqual(["a", "b"])
  })

  test("reads in bounded chunks and reports more until caught up", () => {
    writeFileSync(path, Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n") + "\n")
    const t = make({ chunkBytes: 64 })
    const first = t.readChunk()
    expect(first.more).toBe(true)
    expect(first.lines.length).toBeLessThan(100)
    expect([...first.lines, ...drain(t)]).toHaveLength(100)
  })

  test("a single line longer than a chunk is skipped, not looped on forever", () => {
    writeFileSync(path, "x".repeat(200) + "\nok\n")
    expect(drain(make({ chunkBytes: 64 }))).toEqual(["ok"])
  })

  test("rotates past maxBytes: renames, reopens, then drains and deletes the old file", () => {
    let now = Date.now()
    writeFileSync(path, "a\nb\n")
    const t = make({ maxBytes: 3, settleMs: 5000, now: () => now })
    expect(drain(t)).toEqual(["a", "b"])
    expect(reopens).toBe(1)
    expect(existsSync(`${path}.1`)).toBe(true) // not deleted: not quiet long enough yet
    // Traefik writes one late line into the old file before it reopens.
    appendFileSync(`${path}.1`, "late\n")
    writeFileSync(path, "new\n")
    now += 10_000
    expect(drain(t)).toEqual(["late", "new"])
    expect(existsSync(`${path}.1`)).toBe(false)
  })

  test("a rotated file ending in a never-finished line is still deleted once quiet", () => {
    writeFileSync(`${path}.1`, 'a\n{"cut off')
    writeFileSync(path, "b\n")
    expect(drain(make())).toEqual(["a", "b"])
    expect(existsSync(`${path}.1`)).toBe(false)
  })

  test("the rotated file is kept until it has been quiet for settleMs", () => {
    let now = 1_000_000
    writeFileSync(path, "a\n")
    const t = make({ maxBytes: 1, settleMs: 5000, now: () => now })
    drain(t)
    const rotated = `${path}.1`
    utimesSync(rotated, now / 1000, now / 1000)
    drain(t)
    expect(existsSync(rotated)).toBe(true)
    now += 6000
    drain(t)
    expect(existsSync(rotated)).toBe(false)
  })

  test("a leftover rotated file from a crash is drained before the live file", () => {
    writeFileSync(`${path}.1`, "old\n")
    writeFileSync(path, "new\n")
    expect(drain(make())).toEqual(["old", "new"])
  })

  test("the offset file is written next to the log", () => {
    writeFileSync(path, "a\n")
    drain(make())
    expect(readFileSync(`${path}.offset`, "utf-8").trim()).toBe("2")
  })

  test("a reopen that throws does not lose the chunk, and is retried on the next read", () => {
    let calls = 0
    const logs: string[] = []
    writeFileSync(path, "a\nb\n")
    const t = new AccessLogTailer({
      path,
      maxBytes: 3,
      settleMs: 5000,
      log: (l) => logs.push(l),
      reopen: () => {
        calls++
        if (calls === 1) throw new Error("signal failed")
      },
    })
    expect(t.readChunk().lines).toEqual(["a", "b"])
    expect(calls).toBe(1)
    expect(logs.length).toBe(1)
    t.readChunk()
    expect(calls).toBe(2)
  })

  test("reopen is retried while the fully-read rotated file is still being written", () => {
    const now = Date.now()
    writeFileSync(`${path}.1`, "a\n")
    utimesSync(`${path}.1`, (now - 1000) / 1000, (now - 1000) / 1000)
    const t = make({ settleMs: 5000, now: () => now })
    drain(t)
    expect(reopens).toBe(1)
    drain(t) // unchanged: no further signal
    expect(reopens).toBe(1)
    appendFileSync(`${path}.1`, "late\n")
    utimesSync(`${path}.1`, now / 1000, now / 1000)
    expect(drain(t)).toEqual(["late"])
    expect(reopens).toBe(2)
  })

  test("skipping an oversized line in the rotated file does not eat the next file's first line", () => {
    writeFileSync(`${path}.1`, "x".repeat(200))
    writeFileSync(path, "ok\nnext\n")
    expect(drain(make({ chunkBytes: 64 }))).toEqual(["ok", "next"])
  })

  test("skipping an oversized line does not eat the first line after a truncation", () => {
    writeFileSync(path, "x".repeat(200))
    const t = make({ chunkBytes: 64 })
    t.readChunk()
    t.readChunk()
    t.readChunk()
    writeFileSync(path, "ok\n")
    expect(drain(t)).toEqual(["ok"])
  })
})
