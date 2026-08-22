import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import type { GrantKind, ShareGrant, ShareGrantInfo } from "../../types.ts"
import { generateGrantId, generateGrantToken, hashGrantToken } from "../../utils/grant-token.ts"

export interface CreateGrantInput {
  site: string
  allowBackend?: boolean // let scoped deploys change backend (default false)
  label?: string
}

// Minting a one-time editor-shell code (the in-site live editor). Content-only
// by construction (allowBackend is never set), TTL'd, and spend-capped.
export interface CreateEditInput {
  site: string
  ttlMs: number // code lifetime (e.g. 30 min)
  label?: string
  versionAtStart?: number // site version at mint time (restore-to-start)
  maxTurns?: number
  maxDeploys?: number
}

const EDIT_KINDS: ReadonlySet<GrantKind> = new Set<GrantKind>(["edit", "edit-session"])

export function isEditKind(grant: Pick<ShareGrant, "kind">): boolean {
  return grant.kind !== undefined && EDIT_KINDS.has(grant.kind)
}

// Persists share grants as one JSON file per grant under
// `<dataDir>/share-grants/<id>.json`. Mirrors AppStorage's shape. The raw
// token is never written — only its hash — and is returned once from create().
export class GrantStore {
  private grantsDir: string
  // Lazy hash→id lookup so resolveByToken doesn't read every grant file per
  // request (the cookie-authed editor hits it on every SSE/chat call). Only the
  // hash→id mapping is cached (it never changes for a grant); get(id) always
  // re-reads the file so mutable fields (counters, consumedAt) stay fresh. The
  // index is invalidated only when the *set* of grants changes (create/delete).
  private byHash: Map<string, string> | null = null

  constructor(dataDir: string) {
    this.grantsDir = join(dataDir, "share-grants")
    if (!existsSync(this.grantsDir)) mkdirSync(this.grantsDir, { recursive: true, mode: 0o700 })
  }

  private grantPath(id: string): string {
    return join(this.grantsDir, `${id}.json`)
  }

  private write(grant: ShareGrant): void {
    writeFileSync(this.grantPath(grant.id), JSON.stringify(grant, null, 2), { mode: 0o600 })
  }

  create(input: CreateGrantInput): { grant: ShareGrant; token: string } {
    const token = generateGrantToken()
    const grant: ShareGrant = {
      id: generateGrantId(),
      site: input.site,
      tokenHash: hashGrantToken(token),
      label: input.label,
      allowBackend: input.allowBackend || undefined,
      createdAt: new Date().toISOString(),
      revoked: false,
    }
    this.write(grant)
    this.byHash = null
    return { grant, token }
  }

  // Mint a one-time, TTL'd editor code (grant kind:"edit"). Content-only:
  // allowBackend is deliberately never set. God-mint only (enforced at the
  // route). The raw code is returned once; only its hash is persisted.
  createEdit(input: CreateEditInput): { grant: ShareGrant; token: string } {
    const token = generateGrantToken()
    const now = Date.now()
    const grant: ShareGrant = {
      id: generateGrantId(),
      site: input.site,
      tokenHash: hashGrantToken(token),
      label: input.label,
      createdAt: new Date(now).toISOString(),
      revoked: false,
      kind: "edit",
      expiresAt: new Date(now + input.ttlMs).toISOString(),
      versionAtStart: input.versionAtStart,
      turns: 0,
      deploys: 0,
      maxTurns: input.maxTurns,
      maxDeploys: input.maxDeploys,
    }
    this.write(grant)
    this.byHash = null
    return { grant, token }
  }

  // Derive a cookie-borne session grant from a live edit code. Inherits the
  // parent's site/label/caps/versionAtStart and never outlives it. Callers
  // revoke prior sessions first (single active session) — see server exchange.
  createEditSession(parent: ShareGrant, ttlMs: number): { grant: ShareGrant; token: string } {
    const token = generateGrantToken()
    const now = Date.now()
    // The session cannot outlive its parent code's TTL.
    const parentExpiry = parent.expiresAt ? Date.parse(parent.expiresAt) : now + ttlMs
    const expiresAt = new Date(Math.min(now + ttlMs, parentExpiry)).toISOString()
    const grant: ShareGrant = {
      id: generateGrantId(),
      site: parent.site,
      tokenHash: hashGrantToken(token),
      label: parent.label,
      createdAt: new Date(now).toISOString(),
      revoked: false,
      kind: "edit-session",
      expiresAt,
      parentId: parent.id,
      versionAtStart: parent.versionAtStart,
      turns: 0,
      deploys: 0,
      maxTurns: parent.maxTurns,
      maxDeploys: parent.maxDeploys,
    }
    this.write(grant)
    this.byHash = null
    return { grant, token }
  }

  get(id: string): ShareGrant | null {
    const p = this.grantPath(id)
    if (!existsSync(p)) return null
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as ShareGrant
    } catch {
      return null
    }
  }

  list(): ShareGrant[] {
    if (!existsSync(this.grantsDir)) return []
    return readdirSync(this.grantsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(this.grantsDir, f), "utf-8")) as ShareGrant
        } catch {
          return null
        }
      })
      .filter((g): g is ShareGrant => g !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  // Classic share links for a site (edit-kind grants are hidden — they belong to
  // the transient live-editor flow, not the admin share-links UI).
  listForSite(site: string): ShareGrant[] {
    return this.list().filter((g) => g.site === site && !isEditKind(g))
  }

  // Edit-kind grants for a site, newest first — used by `sites edit --revoke`.
  listEditForSite(site: string): ShareGrant[] {
    return this.list().filter((g) => g.site === site && isEditKind(g))
  }

  // The single chokepoint deciding a grant is *live*. Returns the grant only if
  // it exists, matches the token hash, and is currently active (not revoked and
  // not expired). Uses the hash→id index to avoid scanning every file.
  resolveByToken(token: string): ShareGrant | null {
    const hash = hashGrantToken(token)
    if (!this.byHash) {
      this.byHash = new Map(this.list().map((g) => [g.tokenHash, g.id]))
    }
    const id = this.byHash.get(hash)
    if (!id) return null
    const grant = this.get(id)
    if (!grant || grant.tokenHash !== hash) return null
    if (!this.isActive(grant)) return null
    return grant
  }

  isActive(grant: ShareGrant): boolean {
    if (grant.revoked) return false
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) return false
    return true
  }

  // Mark an edit code as exchanged (first-use timestamp; idempotent). Does NOT
  // block a later re-exchange within TTL — the code stays live so a lost cookie
  // (closed tab) can be re-established; single active session is enforced by
  // revoking prior sessions on each exchange, not by this flag.
  consume(id: string): ShareGrant | null {
    const grant = this.get(id)
    if (!grant) return null
    if (grant.consumedAt) return grant
    const updated: ShareGrant = { ...grant, consumedAt: new Date().toISOString() }
    this.write(updated)
    return updated
  }

  // Bump a per-turn counter; returns the updated grant (null if gone).
  bumpTurns(id: string): ShareGrant | null {
    const grant = this.get(id)
    if (!grant) return null
    const updated: ShareGrant = { ...grant, turns: (grant.turns ?? 0) + 1 }
    this.write(updated)
    return updated
  }

  bumpDeploys(id: string): ShareGrant | null {
    const grant = this.get(id)
    if (!grant) return null
    const updated: ShareGrant = { ...grant, deploys: (grant.deploys ?? 0) + 1 }
    this.write(updated)
    return updated
  }

  // Whether a grant has hit its turn or deploy cap. Uncapped grants never reach.
  capReached(grant: ShareGrant): boolean {
    if (grant.maxTurns !== undefined && (grant.turns ?? 0) >= grant.maxTurns) return true
    if (grant.maxDeploys !== undefined && (grant.deploys ?? 0) >= grant.maxDeploys) return true
    return false
  }

  // Stamp the grant's last-used time after a deploy (informational only).
  touch(id: string): ShareGrant | null {
    const grant = this.get(id)
    if (!grant) return null
    const updated: ShareGrant = { ...grant, lastUsedAt: new Date().toISOString() }
    this.write(updated)
    return updated
  }

  revoke(id: string): boolean {
    const grant = this.get(id)
    if (!grant) return false
    this.write({ ...grant, revoked: true })
    // Revoke cascade: killing an edit code also kills its derived sessions, so
    // the owner never has to know the (invisible) session ids.
    for (const child of this.list()) {
      if (child.parentId === id && !child.revoked) this.write({ ...child, revoked: true })
    }
    return true
  }

  delete(id: string): boolean {
    const p = this.grantPath(id)
    if (!existsSync(p)) return false
    rmSync(p)
    this.byHash = null
    return true
  }

  // Garbage-collect dead grants (revoked or expired). Returns the ids removed so
  // the caller can reclaim their staging dirs. Called at startup and eagerly so
  // consumed/expired edit codes don't accumulate.
  gc(): string[] {
    const removed: string[] = []
    for (const grant of this.list()) {
      if (!this.isActive(grant)) {
        if (this.delete(grant.id)) removed.push(grant.id)
      }
    }
    return removed
  }

  toInfo(grant: ShareGrant): ShareGrantInfo {
    const { tokenHash: _drop, ...rest } = grant
    return {
      id: rest.id,
      site: rest.site,
      label: rest.label,
      allowBackend: rest.allowBackend,
      createdAt: rest.createdAt,
      lastUsedAt: rest.lastUsedAt,
      revoked: rest.revoked,
      active: this.isActive(grant),
      kind: rest.kind,
      expiresAt: rest.expiresAt,
      consumedAt: rest.consumedAt,
      versionAtStart: rest.versionAtStart,
    }
  }
}
