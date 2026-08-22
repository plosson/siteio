import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { GrantStore } from "../../lib/agent/grant-store.ts"

describe("Unit: GrantStore", () => {
  let dataDir: string
  let store: GrantStore

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-grants-"))
    store = new GrantStore(dataDir)
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  const grantFile = (id: string) => join(dataDir, "share-grants", `${id}.json`)

  test("create returns a raw token that resolves back to the grant", () => {
    const { grant, token } = store.create({ site: "blog" })
    expect(token).toStartWith("grt_")
    expect(grant.site).toBe("blog")
    expect(grant.revoked).toBe(false)

    const resolved = store.resolveByToken(token)
    expect(resolved?.id).toBe(grant.id)
  })

  test("the raw token is never persisted — only its hash", () => {
    const { grant, token } = store.create({ site: "blog" })
    const onDisk = readFileSync(grantFile(grant.id), "utf-8")
    expect(onDisk).not.toContain(token)
    expect(JSON.parse(onDisk).tokenHash).toBeTruthy()
  })

  test("toInfo strips the token hash and reports active", () => {
    const { grant } = store.create({ site: "blog" })
    const info = store.toInfo(grant)
    expect((info as unknown as Record<string, unknown>).tokenHash).toBeUndefined()
    expect(info.active).toBe(true)
  })

  test("allowBackend is persisted when set", () => {
    const { grant } = store.create({ site: "blog", allowBackend: true })
    expect(grant.allowBackend).toBe(true)
    expect(store.toInfo(grant).allowBackend).toBe(true)
    // Omitted by default (not stored as false).
    const { grant: plain } = store.create({ site: "blog" })
    expect(plain.allowBackend).toBeUndefined()
  })

  test("a share stays active indefinitely until revoked", () => {
    const { token, grant } = store.create({ site: "blog" })
    // No budget, no expiry — repeated resolution keeps working.
    expect(store.resolveByToken(token)?.id).toBe(grant.id)
    expect(store.resolveByToken(token)?.id).toBe(grant.id)
    store.touch(grant.id)
    expect(store.resolveByToken(token)?.id).toBe(grant.id)
  })

  test("resolveByToken returns null after revoke", () => {
    const { token, grant } = store.create({ site: "blog" })
    store.revoke(grant.id)
    expect(store.resolveByToken(token)).toBeNull()
    expect(store.toInfo(store.get(grant.id)!).active).toBe(false)
  })

  test("resolveByToken returns null for an unknown token", () => {
    store.create({ site: "blog" })
    expect(store.resolveByToken("grt_nonexistenttokenvalue123456")).toBeNull()
  })

  test("touch stamps lastUsedAt without otherwise changing the grant", () => {
    const { grant } = store.create({ site: "blog" })
    expect(grant.lastUsedAt).toBeUndefined()
    const updated = store.touch(grant.id)!
    expect(updated.lastUsedAt).toBeTruthy()
    expect(updated.revoked).toBe(false)
  })

  test("listForSite scopes to one site", () => {
    store.create({ site: "blog" })
    store.create({ site: "blog" })
    store.create({ site: "shop" })
    expect(store.listForSite("blog")).toHaveLength(2)
    expect(store.listForSite("shop")).toHaveLength(1)
  })

  test("gc removes revoked grants and returns their ids, keeping live ones", () => {
    const live = store.create({ site: "blog" })
    const revoked = store.create({ site: "blog" })
    store.revoke(revoked.grant.id)

    const removed = store.gc()
    expect(removed).toEqual([revoked.grant.id])
    expect(existsSync(grantFile(live.grant.id))).toBe(true)
    expect(existsSync(grantFile(revoked.grant.id))).toBe(false)
    expect(readdirSync(join(dataDir, "share-grants"))).toHaveLength(1)
  })

  // --- edit-link grants ---

  test("createEdit mints a content-only, TTL'd code that resolves within TTL", () => {
    const { grant, token } = store.createEdit({ site: "blog", ttlMs: 30 * 60_000, versionAtStart: 3 })
    expect(grant.kind).toBe("edit")
    expect(grant.allowBackend).toBeUndefined()
    expect(grant.versionAtStart).toBe(3)
    expect(grant.expiresAt).toBeTruthy()
    expect(store.resolveByToken(token)?.id).toBe(grant.id)
  })

  test("an expired edit code no longer resolves and gc reaps it", () => {
    const { grant, token } = store.createEdit({ site: "blog", ttlMs: -1 }) // already expired
    expect(store.isActive(grant)).toBe(false)
    expect(store.resolveByToken(token)).toBeNull()
    expect(store.gc()).toEqual([grant.id])
  })

  test("consume stamps consumedAt once but the code stays resolvable (re-establishable)", () => {
    const { grant, token } = store.createEdit({ site: "blog", ttlMs: 30 * 60_000 })
    expect(grant.consumedAt).toBeUndefined()
    const first = store.consume(grant.id)!
    expect(first.consumedAt).toBeTruthy()
    // Idempotent: a second consume keeps the original timestamp.
    const second = store.consume(grant.id)!
    expect(second.consumedAt).toBe(first.consumedAt)
    // Still live within TTL so a lost cookie can be re-established.
    expect(store.resolveByToken(token)?.id).toBe(grant.id)
  })

  test("edit sessions derive from a code, never outlive it, and cascade on revoke", () => {
    const { grant: code } = store.createEdit({ site: "blog", ttlMs: 60_000 })
    const { grant: session, token: sessionToken } = store.createEditSession(code, 30 * 60_000)
    expect(session.kind).toBe("edit-session")
    expect(session.parentId).toBe(code.id)
    // Clamped to the parent's (shorter) TTL.
    expect(Date.parse(session.expiresAt!)).toBeLessThanOrEqual(Date.parse(code.expiresAt!))
    expect(store.resolveByToken(sessionToken)?.id).toBe(session.id)

    // Revoking the code cascades to the session.
    store.revoke(code.id)
    expect(store.resolveByToken(sessionToken)).toBeNull()
    expect(store.get(session.id)?.revoked).toBe(true)
  })

  test("edit-kind grants are hidden from listForSite but visible via listEditForSite", () => {
    store.create({ site: "blog" }) // classic share
    const { grant: code } = store.createEdit({ site: "blog", ttlMs: 60_000 })
    expect(store.listForSite("blog")).toHaveLength(1) // only the classic share
    expect(store.listForSite("blog").some((g) => g.id === code.id)).toBe(false)
    expect(store.listEditForSite("blog").map((g) => g.id)).toEqual([code.id])
  })

  test("spend cap: capReached flips once turns hit maxTurns", () => {
    const { grant } = store.createEdit({ site: "blog", ttlMs: 60_000, maxTurns: 2 })
    expect(store.capReached(grant)).toBe(false)
    store.bumpTurns(grant.id)
    expect(store.capReached(store.get(grant.id)!)).toBe(false)
    store.bumpTurns(grant.id)
    expect(store.capReached(store.get(grant.id)!)).toBe(true)
  })

  test("toInfo surfaces edit metadata and computes active from expiry", () => {
    const { grant } = store.createEdit({ site: "blog", ttlMs: 60_000 })
    const info = store.toInfo(grant)
    expect(info.kind).toBe("edit")
    expect(info.expiresAt).toBe(grant.expiresAt)
    expect(info.active).toBe(true)
  })
})
