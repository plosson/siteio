import type { Tenant } from "../../types.ts"
import { ValidationError } from "../../utils/errors.ts"

// Multi-tenant base domains. The agent's own domain is the primary scope
// (`null`); each tenant adds a base domain whose sites live at
// `<name>.<tenant domain>`. Storage, Docker, Traefik and grants keep using one
// flat string per site — its *key* — so tenancy only exists at the edges:
//   primary site `blog`             → key `blog`
//   tenant `friend.com` site `blog` → key `blog--friend-com`
// User-chosen names may never contain `--`, so a key splits unambiguously at
// its first `--`.
export type Scope = Tenant | null

const KEY_SEP = "--"
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/

export function tenantSlug(domain: string): string {
  return domain.replace(/\./g, "-")
}

// Validation for a name a user is about to create (site, app, rename target).
export function assertValidNewName(name: string, kind: "Site" | "App" = "Site"): void {
  if (!name) throw new ValidationError(`${kind} name cannot be empty`)
  if (!NAME_RE.test(name)) {
    throw new ValidationError(`${kind} name must contain only lowercase letters, numbers, and hyphens`)
  }
  if (name === "api") throw new ValidationError("'api' is a reserved name")
  if (name.includes(KEY_SEP)) throw new ValidationError(`'${KEY_SEP}' is reserved in ${kind.toLowerCase()} names`)
}

export class TenantRegistry {
  private bySlug = new Map<string, Tenant>()

  constructor(readonly primaryDomain: string, readonly tenants: Tenant[] = []) {
    for (const t of tenants) this.bySlug.set(tenantSlug(t.domain), t)
  }

  // Every scope, primary first.
  private scopes(): Scope[] {
    return [null, ...this.tenants]
  }

  // The key for `name` as addressed from `scope`.
  keyFor(name: string, scope: Scope): string {
    if (!scope) return name
    if (!NAME_RE.test(name)) {
      throw new ValidationError(`name must contain only lowercase letters, numbers, and hyphens`)
    }
    if (name.includes(KEY_SEP)) throw new ValidationError(`'${KEY_SEP}' is not allowed in names`)
    return `${name}${KEY_SEP}${tenantSlug(scope.domain)}`
  }

  // The tenant owning a key, or null for the primary domain.
  ownerOf(key: string): Scope {
    const i = key.indexOf(KEY_SEP)
    return i < 0 ? null : this.bySlug.get(key.slice(i + KEY_SEP.length)) ?? null
  }

  // How `scope` sees a key: a tenant sees its own keys as bare names and no
  // others; the primary scope (the operator) sees every key as-is.
  nameIn(key: string, scope: Scope): string | null {
    if (!scope) return key
    if (this.ownerOf(key)?.domain !== scope.domain) return null
    return key.slice(0, key.indexOf(KEY_SEP))
  }

  inScope(key: string, scope: Scope): boolean {
    return this.nameIn(key, scope) !== null
  }

  baseDomain(scope: Scope): string {
    return scope ? scope.domain : this.primaryDomain
  }

  // Platform hostname of a site: `<name>.<its owner's base domain>`.
  host(key: string): string {
    const owner = this.ownerOf(key)
    return owner ? `${key.slice(0, key.indexOf(KEY_SEP))}.${owner.domain}` : `${key}.${this.primaryDomain}`
  }

  // Scope of an `api.<base>` host; undefined when the host is no API host.
  apiScope(host: string): Scope | undefined {
    return this.scopes().find((s) => host === `api.${this.baseDomain(s)}`)
  }

  // The site a platform hostname `<name>.<base>` addresses. Custom domains are
  // resolved separately (SiteStorage.findByCustomDomain).
  siteFromHost(host: string): { key: string; scope: Scope } | null {
    for (const scope of this.scopes()) {
      const suffix = `.${this.baseDomain(scope)}`
      if (!host.endsWith(suffix)) continue
      const name = host.slice(0, -suffix.length)
      if (!NAME_RE.test(name) || name === "api" || name.includes(KEY_SEP)) return null
      return { key: this.keyFor(name, scope), scope }
    }
    return null
  }

  findByApiKey(apiKey: string): Tenant | null {
    if (!apiKey) return null
    return this.tenants.find((t) => t.apiKey === apiKey) ?? null
  }

  apiHosts(): string[] {
    return this.scopes().map((s) => `api.${this.baseDomain(s)}`)
  }

  // Why `domain` can't be a custom domain of a site owned by `owner`, or null.
  // Subdomains of every base domain are platform hostnames, and each base
  // domain's apex belongs to its own scope.
  customDomainConflict(domain: string, owner: Scope): string | null {
    for (const scope of this.scopes()) {
      const base = this.baseDomain(scope)
      if (domain.endsWith(`.${base}`)) {
        return `Cannot use '${domain}' as a custom domain — it conflicts with the base domain subdomains`
      }
      if (domain === base && scope?.domain !== owner?.domain) {
        return `Cannot use '${domain}' as a custom domain — it belongs to another domain on this server`
      }
    }
    return null
  }

  // Why `domain` can't become a new tenant, or null.
  checkNewTenant(domain: string): string | null {
    if (!DOMAIN_RE.test(domain)) return `Invalid domain: '${domain}'`
    for (const scope of this.scopes()) {
      const base = this.baseDomain(scope)
      if (domain === base || domain.endsWith(`.${base}`) || base.endsWith(`.${domain}`)) {
        return `'${domain}' overlaps '${base}', already served by this agent`
      }
    }
    if (this.bySlug.has(tenantSlug(domain))) {
      return `'${domain}' maps to the same internal name as an existing tenant`
    }
    return null
  }
}
