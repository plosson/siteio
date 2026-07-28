import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import type { ShareGrant, ShareGrantInfo } from "../../types.ts"
import { ValidationError } from "../../utils/errors.ts"
import { generateGrantId, generateGrantToken, hashGrantToken } from "../../utils/grant-token.ts"

export interface CreateGrantInput {
  site: string
  allowBackend?: boolean // let scoped deploys change backend (default false)
  label?: string
}

// Persists share grants as one JSON file per grant under
// `<dataDir>/share-grants/<id>.json`. Mirrors AppStorage's shape. The raw
// token is never written — only its hash — and is returned once from create().
export class GrantStore {
  private grantsDir: string

  constructor(dataDir: string) {
    this.grantsDir = join(dataDir, "share-grants")
    if (!existsSync(this.grantsDir)) mkdirSync(this.grantsDir, { recursive: true, mode: 0o700 })
  }

  private grantPath(id: string): string {
    return join(this.grantsDir, `${id}.json`)
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
    writeFileSync(this.grantPath(grant.id), JSON.stringify(grant, null, 2), { mode: 0o600 })
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

  listForSite(site: string): ShareGrant[] {
    return this.list().filter((g) => g.site === site)
  }

  // The single chokepoint deciding a grant is *live*. Returns the grant only if
  // it exists, matches the token hash, and is not revoked.
  resolveByToken(token: string): ShareGrant | null {
    const hash = hashGrantToken(token)
    const grant = this.list().find((g) => g.tokenHash === hash)
    if (!grant) return null
    if (!this.isActive(grant)) return null
    return grant
  }

  isActive(grant: ShareGrant): boolean {
    return !grant.revoked
  }

  // Stamp the grant's last-used time after a deploy (informational only).
  touch(id: string): ShareGrant | null {
    const grant = this.get(id)
    if (!grant) return null
    const updated: ShareGrant = { ...grant, lastUsedAt: new Date().toISOString() }
    writeFileSync(this.grantPath(id), JSON.stringify(updated, null, 2), { mode: 0o600 })
    return updated
  }

  revoke(id: string): boolean {
    const grant = this.get(id)
    if (!grant) return false
    const updated: ShareGrant = { ...grant, revoked: true }
    writeFileSync(this.grantPath(id), JSON.stringify(updated, null, 2), { mode: 0o600 })
    return true
  }

  delete(id: string): boolean {
    const p = this.grantPath(id)
    if (!existsSync(p)) return false
    rmSync(p)
    return true
  }

  // Garbage-collect dead (revoked) grants. Returns the ids removed so the
  // caller can reclaim their staging dirs.
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
    return { ...rest, active: this.isActive(grant) }
  }
}
