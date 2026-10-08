import type { Tenant } from "../../types.ts"
import { ValidationError } from "../../utils/errors.ts"
import type { SiteStorage } from "./storage.ts"
import type { AppStorage } from "./app-storage.ts"

// Multi-tenant base domains. The agent's own domain is the primary scope
// (`null`); each tenant adds a base domain whose sites live at
// `<name>.<tenant domain>`. Storage, Docker, Traefik and grants keep using one
// flat string per site — its *key* — so tenancy only exists at the edges:
//   primary site `blog`             → key `blog`
//   tenant `friend.com` site `blog` → key `blog--friend-com`
// User-chosen names may never contain `--`, so a key splits unambiguously at
// its first `--`.
export type Scope = Tenant | null

// A site or app as checkNewTenant sees it: its key and its custom domains.
export type TenantService = { kind: "Site" | "App"; name: string; domains: string[] }

export function tenantServices(sites: SiteStorage, apps: AppStorage): TenantService[] {
  return [
    ...sites.list().map((s) => ({ kind: "Site" as const, name: s.name, domains: s.domains })),
    ...apps.list().map((a) => ({ kind: "App" as const, name: a.name, domains: a.domains })),
  ]
}

const KEY_SEP = "--"
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/

export function isValidDomain(domain: string): boolean {
  return DOMAIN_RE.test(domain)
}

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

  // The key for `name` as addressed from `scope`. Throws on a name a tenant
  // can't have; the primary scope addresses existing keys as-is.
  keyFor(name: string, scope: Scope): string {
    if (!scope) return name
    assertValidNewName(name)
    return `${name}${KEY_SEP}${tenantSlug(scope.domain)}`
  }

  // The key `name` addresses from `scope`, or null when no site can have that
  // name there. Primary sites that predate the `--` reservation keep
  // resolving, unless the name is a tenant's key (that would let the primary
  // domain forge it).
  resolve(name: string, scope: Scope): string | null {
    if (!NAME_RE.test(name) || name === "api") return null
    if (name.includes(KEY_SEP) && (scope || this.ownerOf(name))) return null
    return this.keyFor(name, scope)
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

  // The name shown for a key: as `scope` sees it, defaulting to the owner's
  // view (so a tenant site reads `blog`, never `blog--friend-com`).
  displayName(key: string, scope: Scope = this.ownerOf(key)): string {
    return this.nameIn(key, scope) ?? key
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
      const key = this.resolve(host.slice(0, -suffix.length), scope)
      return key ? { key, scope } : null
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
      if (owner && base.endsWith(`.${domain}`)) {
        return `Cannot use '${domain}' as a custom domain — it contains another domain on this server`
      }
      if (domain.endsWith(`.${base}`)) {
        return `Cannot use '${domain}' as a custom domain — it conflicts with the base domain subdomains`
      }
      if (domain === base && scope?.domain !== owner?.domain) {
        return `Cannot use '${domain}' as a custom domain — it belongs to another domain on this server`
      }
    }
    return null
  }

  // Why `domain` can't become a new tenant, or null. Its hostnames must be
  // free (no site or app may already use the domain or a subdomain of it as a
  // custom domain), and existing keys ending in its slug would be captured by it.
  checkNewTenant(domain: string, services: TenantService[] = []): string | null {
    if (!isValidDomain(domain)) return `Invalid domain: '${domain}'`
    for (const scope of this.scopes()) {
      const base = this.baseDomain(scope)
      if (domain === base || domain.endsWith(`.${base}`) || base.endsWith(`.${domain}`)) {
        return `'${domain}' overlaps '${base}', already served by this agent`
      }
    }
    if (this.bySlug.has(tenantSlug(domain))) {
      return `'${domain}' maps to the same internal name as an existing tenant`
    }
    const taken = (d: string) => d === domain || d.endsWith(`.${domain}`)
    const suffix = `${KEY_SEP}${tenantSlug(domain)}`
    for (const { kind, name, domains } of services) {
      if (domains.some(taken)) return `${kind} '${name}' already uses a domain under '${domain}'`
      if (name.endsWith(suffix)) return `${kind} '${name}' would be captured by tenant '${domain}'`
    }
    return null
  }

  // Serve a new tenant from now on. Callers check it with checkNewTenant first.
  add(tenant: Tenant): void {
    this.tenants.push(tenant)
    this.bySlug.set(tenantSlug(tenant.domain), tenant)
  }
}
