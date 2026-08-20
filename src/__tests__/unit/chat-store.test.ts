import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, statSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { ChatStore } from "../../lib/agent/chat-store.ts"
import type { ChatMessage } from "../../types.ts"

const msg = (id: string, role: ChatMessage["role"], text: string): ChatMessage => ({
  id, role, text, at: new Date().toISOString(),
})

describe("Unit: ChatStore", () => {
  let dir: string
  let store: ChatStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "siteio-chat-store-"))
    store = new ChatStore(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("empty site returns []", () => {
    expect(store.list("blog")).toEqual([])
  })

  test("append and list preserve order", () => {
    store.append("blog", msg("1", "user", "hi"))
    store.append("blog", msg("2", "assistant", "done"))
    const all = store.list("blog")
    expect(all.map((m) => m.id)).toEqual(["1", "2"])
  })

  test("transcript is written 0600", () => {
    store.append("blog", msg("1", "user", "hi"))
    const p = join(dir, "pocket-chat", "blog", "messages.json")
    expect(existsSync(p)).toBe(true)
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })

  test("update patches a message in place", () => {
    store.append("blog", msg("1", "assistant", "x"))
    expect(store.update("blog", "1", { status: "ok", versionAfter: 5 })).toBe(true)
    expect(store.update("blog", "missing", { status: "ok" })).toBe(false)
    const m = store.list("blog")[0]!
    expect(m.status).toBe("ok")
    expect(m.versionAfter).toBe(5)
  })

  test("clear removes history", () => {
    store.append("blog", msg("1", "user", "hi"))
    store.clear("blog")
    expect(store.list("blog")).toEqual([])
  })

  test("rename moves the transcript", () => {
    store.append("blog", msg("1", "user", "hi"))
    store.rename("blog", "journal")
    expect(store.list("blog")).toEqual([])
    expect(store.list("journal").map((m) => m.id)).toEqual(["1"])
  })

  test("rename of a site with no history is a no-op", () => {
    expect(() => store.rename("ghost", "spirit")).not.toThrow()
    expect(store.list("spirit")).toEqual([])
  })
})
