import { describe, test, expect } from "bun:test"
import { TenantRegistry, tenantSlug, assertValidNewName } from "../../lib/agent/tenants.ts"
import type { Tenant } from "../../types.ts"

const A: Tenant = { domain: "friend.com", apiKey: "key-a", createdAt: "2026-10-08T00:00:00.000Z" }
const B: Tenant = { domain: "other.org", apiKey: "key-b", createdAt: "2026-10-08T00:00:00.000Z" }
const reg = new TenantRegistry("example.com", [A, B])

describe("tenantSlug / assertValidNewName", () => {
  test("slug replaces dots", () => {
    expect(tenantSlug("friend.co.uk")).toBe("friend-co-uk")
  })

  test("rejects names that could forge a key or break routing", () => {
    for (const bad of ["", "Blog", "a.b", "a_b", "api", "a--b", "--", "blog--friend-com"]) {
      expect(() => assertValidNewName(bad)).toThrow()
    }
    expect(() => assertValidNewName("my-blog")).not.toThrow()
  })

  test("names the kind in the message", () => {
    expect(() => assertValidNewName("", "App")).toThrow("App name cannot be empty")
  })

  test("rejects names starting or ending with hyphens", () => {
    expect(() => assertValidNewName("blog-")).toThrow()
    expect(() => assertValidNewName("-blog")).toThrow()
  })
})

describe("TenantRegistry keys", () => {
  test("primary keys are bare names; tenant keys carry the slug", () => {
    expect(reg.keyFor("blog", null)).toBe("blog")
    expect(reg.keyFor("blog", A)).toBe("blog--friend-com")
  })

  test("a tenant can never form a key containing another slug", () => {
    expect(() => reg.keyFor("blog--other-org", A)).toThrow()
  })

  test("a tenant cannot form a key from an invalid name", () => {
    expect(() => reg.keyFor("blog-", A)).toThrow()
    expect(() => reg.keyFor("-blog", A)).toThrow()
  })

  test("ownerOf splits at the first --", () => {
    expect(reg.ownerOf("blog")).toBeNull()
    expect(reg.ownerOf("blog--friend-com")?.domain).toBe("friend.com")
    expect(reg.ownerOf("blog--unknown-net")).toBeNull()
  })

  test("a tenant sees only its own keys, as bare names", () => {
    expect(reg.nameIn("blog--friend-com", A)).toBe("blog")
    expect(reg.nameIn("blog--other-org", A)).toBeNull()
    expect(reg.nameIn("blog", A)).toBeNull()
    expect(reg.inScope("blog", A)).toBe(false)
  })

  test("the primary scope sees every key as-is", () => {
    expect(reg.nameIn("blog", null)).toBe("blog")
    expect(reg.nameIn("blog--friend-com", null)).toBe("blog--friend-com")
    expect(reg.inScope("blog--friend-com", null)).toBe(true)
  })

  test("host() puts each site on its owner's base domain", () => {
    expect(reg.host("blog")).toBe("blog.example.com")
    expect(reg.host("blog--friend-com")).toBe("blog.friend.com")
  })
})

describe("TenantRegistry hosts", () => {
  test("apiScope distinguishes primary, tenant and unknown hosts", () => {
    expect(reg.apiScope("api.example.com")).toBeNull()
    expect(reg.apiScope("api.friend.com")?.domain).toBe("friend.com")
    expect(reg.apiScope("api.evil.com")).toBeUndefined()
    expect(reg.apiScope("x.api.friend.com")).toBeUndefined()
    expect(reg.apiScope("friend.com")).toBeUndefined()
  })

  test("siteFromHost maps platform hostnames to keys", () => {
    expect(reg.siteFromHost("blog.friend.com")).toEqual({ key: "blog--friend-com", scope: A })
    expect(reg.siteFromHost("blog.example.com")).toEqual({ key: "blog", scope: null })
  })

  test("siteFromHost refuses hosts that could reach another scope", () => {
    for (const host of [
      "blog--friend-com.example.com", // a tenant key through the primary domain
      "a--b.friend.com",
      "api.friend.com",
      "a.b.friend.com",
      "friend.com",
      "blog.notfriend.com",
    ]) {
      expect(reg.siteFromHost(host)).toBeNull()
    }
  })

  test("siteFromHost refuses hosts with invalid names (leading/trailing hyphens)", () => {
    expect(reg.siteFromHost("blog-.friend.com")).toBeNull()
    expect(reg.siteFromHost("-blog.friend.com")).toBeNull()
  })

  test("a primary site whose name contains -- stays addressable unless it forges a tenant key", () => {
    expect(reg.siteFromHost("my--site.example.com")).toEqual({ key: "my--site", scope: null })
    expect(reg.siteFromHost("blog--friend-com.example.com")).toBeNull()
    expect(reg.siteFromHost("my--site.friend.com")).toBeNull()
  })

  test("findByApiKey and apiHosts", () => {
    expect(reg.findByApiKey("key-b")?.domain).toBe("other.org")
    expect(reg.findByApiKey("")).toBeNull()
    expect(reg.findByApiKey("nope")).toBeNull()
    expect(reg.apiHosts()).toEqual(["api.example.com", "api.friend.com", "api.other.org"])
  })
})

describe("TenantRegistry custom domains", () => {
  test("own apex is allowed, other scopes' apexes are not", () => {
    expect(reg.customDomainConflict("friend.com", A)).toBeNull()
    expect(reg.customDomainConflict("example.com", null)).toBeNull()
    expect(reg.customDomainConflict("other.org", A)).not.toBeNull()
    expect(reg.customDomainConflict("example.com", A)).not.toBeNull()
    expect(reg.customDomainConflict("friend.com", null)).not.toBeNull()
  })

  test("a tenant can't claim a parent of any base domain; the primary can", () => {
    const r = new TenantRegistry("siteio.example.com", [A])
    expect(r.customDomainConflict("example.com", A)).toBe(
      "Cannot use 'example.com' as a custom domain — it contains another domain on this server"
    )
    expect(r.customDomainConflict("example.com", null)).toBeNull()
    expect(r.customDomainConflict("www.unrelated.net", A)).toBeNull()
  })

  test("no platform hostname of any base domain", () => {
    for (const d of ["x.example.com", "api.friend.com", "x.friend.com", "deep.x.other.org"]) {
      expect(reg.customDomainConflict(d, A)).not.toBeNull()
    }
    expect(reg.customDomainConflict("www.unrelated.net", A)).toBeNull()
  })
})

describe("TenantRegistry.checkNewTenant", () => {
  test("accepts an unrelated domain", () => {
    expect(reg.checkNewTenant("third.net")).toBeNull()
  })

  test("refuses invalid, equal and nested domains", () => {
    for (const d of ["", "Friend.com", "nodot", "example.com", "friend.com", "x.example.com", "sub.other.org", "org", "com"]) {
      expect(reg.checkNewTenant(d)).not.toBeNull()
    }
  })

  test("refuses a slug collision", () => {
    const r = new TenantRegistry("example.com", [{ domain: "a-b.co.uk", apiKey: "k", createdAt: "" }])
    expect(r.checkNewTenant("a.b-co.uk")).not.toBeNull()
  })
})
