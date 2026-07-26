import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { GrantStore, HARD_MAX_TTL_MS } from "../../lib/agent/grant-store.ts"
import type { ShareGrant } from "../../types.ts"

describe("Unit: GrantStore", () => {
  let dataDir: string
  let store: GrantStore

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-grants-"))
    store = new GrantStore(dataDir)
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  const grantFile = (id: string) => join(dataDir, "share-grants", `${id}.json`)
  const rewrite = (id: string, patch: Partial<ShareGrant>) => {
    const g = JSON.parse(readFileSync(grantFile(id), "utf-8")) as ShareGrant
    writeFileSync(grantFile(id), JSON.stringify({ ...g, ...patch }))
  }

  test("create returns a raw token that resolves back to the grant", () => {
    const { grant, token } = store.create({ site: "blog" })
    expect(token).toStartWith("grt_")
    expect(grant.site).toBe("blog")
    expect(grant.maxDeploys).toBe(1)
    expect(grant.deploysUsed).toBe(0)

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

  test("maxDeploys must be a positive integer", () => {
    expect(() => store.create({ site: "blog", maxDeploys: 0 })).toThrow()
    expect(() => store.create({ site: "blog", maxDeploys: -2 })).toThrow()
  })

  test("expiry is capped at the hard max TTL", () => {
    const { grant } = store.create({ site: "blog", expiresInMs: 999 * 24 * 60 * 60 * 1000 })
    expect(grant.expiresAt).toBeTruthy()
    const ttl = Date.parse(grant.expiresAt!) - Date.parse(grant.createdAt)
    expect(ttl).toBeLessThanOrEqual(HARD_MAX_TTL_MS)
  })

  test("neverExpires creates a grant with no expiry that stays active", () => {
    const { grant, token } = store.create({ site: "blog", neverExpires: true })
    expect(grant.expiresAt).toBeUndefined()
    expect(store.toInfo(grant).expiresAt).toBeUndefined()
    expect(store.resolveByToken(token)?.id).toBe(grant.id)
  })

  test("a never-expiring grant is still gated by its deploy budget", () => {
    const { grant, token } = store.create({ site: "blog", neverExpires: true, maxDeploys: 1 })
    store.recordDeploy(grant.id)
    expect(store.resolveByToken(token)).toBeNull() // budget, not time, retires it
  })

  test("gc keeps a never-expiring grant with budget remaining", () => {
    const { grant } = store.create({ site: "blog", neverExpires: true, maxDeploys: 2 })
    expect(store.gc()).toEqual([])
    expect(store.get(grant.id)).not.toBeNull()
  })

  test("resolveByToken returns null for an exhausted budget", () => {
    const { token, grant } = store.create({ site: "blog", maxDeploys: 1 })
    store.recordDeploy(grant.id)
    expect(store.resolveByToken(token)).toBeNull()
  })

  test("resolveByToken returns null after revoke", () => {
    const { token, grant } = store.create({ site: "blog" })
    store.revoke(grant.id)
    expect(store.resolveByToken(token)).toBeNull()
    expect(store.toInfo(store.get(grant.id)!).active).toBe(false)
  })

  test("resolveByToken returns null for an expired grant", () => {
    const { token, grant } = store.create({ site: "blog" })
    rewrite(grant.id, { expiresAt: new Date(Date.now() - 1000).toISOString() })
    expect(store.resolveByToken(token)).toBeNull()
  })

  test("resolveByToken returns null for an unknown token", () => {
    store.create({ site: "blog" })
    expect(store.resolveByToken("grt_nonexistenttokenvalue123456")).toBeNull()
  })

  test("recordDeploy increments usage and stamps lastUsedAt", () => {
    const { grant } = store.create({ site: "blog", maxDeploys: 3 })
    const updated = store.recordDeploy(grant.id)!
    expect(updated.deploysUsed).toBe(1)
    expect(updated.lastUsedAt).toBeTruthy()
  })

  test("listForSite scopes to one site", () => {
    store.create({ site: "blog" })
    store.create({ site: "blog" })
    store.create({ site: "shop" })
    expect(store.listForSite("blog")).toHaveLength(2)
    expect(store.listForSite("shop")).toHaveLength(1)
  })

  test("gc removes revoked / expired / exhausted grants and returns their ids", () => {
    const live = store.create({ site: "blog", maxDeploys: 5 })
    const expired = store.create({ site: "blog" })
    const revoked = store.create({ site: "blog" })
    rewrite(expired.grant.id, { expiresAt: new Date(Date.now() - 1000).toISOString() })
    store.revoke(revoked.grant.id)

    const removed = store.gc()
    expect(removed.sort()).toEqual([expired.grant.id, revoked.grant.id].sort())
    expect(existsSync(grantFile(live.grant.id))).toBe(true)
    expect(existsSync(grantFile(expired.grant.id))).toBe(false)
    expect(readdirSync(join(dataDir, "share-grants"))).toHaveLength(1)
  })
})
