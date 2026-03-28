import { describe, test, expect } from "bun:test"
import { isSslipDomain, buildSslipDomain, buildCloudflareTokenUrl } from "../../lib/cloudflare.ts"

describe("Install flow: domain type detection", () => {
  test("sslip.io domain skips cloudflare", () => {
    expect(isSslipDomain("203-0-113-42.sslip.io")).toBe(true)
  })

  test("custom domain requires cloudflare", () => {
    expect(isSslipDomain("myserver.example.com")).toBe(false)
  })

  test("nip.io is not treated as sslip", () => {
    expect(isSslipDomain("10-0-0-1.nip.io")).toBe(false)
  })
})

describe("Install flow: sslip domain generation", () => {
  test("generates valid sslip domain from IPv4", () => {
    const domain = buildSslipDomain("192.168.1.100")
    expect(domain).toBe("192-168-1-100.sslip.io")
    expect(isSslipDomain(domain)).toBe(true)
  })
})

describe("Install flow: cloudflare template URL", () => {
  test("default URL has correct permissions", () => {
    const url = buildCloudflareTokenUrl()
    const parsed = new URL(url)
    const permissions = JSON.parse(parsed.searchParams.get("permissionGroupKeys")!)
    expect(permissions).toEqual([
      { key: "zone", type: "read" },
      { key: "zone_dns", type: "edit" },
    ])
  })

  test("default URL has siteio token name", () => {
    const url = buildCloudflareTokenUrl()
    const parsed = new URL(url)
    expect(parsed.searchParams.get("name")).toBe("siteio DNS Token")
  })

  test("custom token name is included", () => {
    const url = buildCloudflareTokenUrl("my custom name")
    const parsed = new URL(url)
    expect(parsed.searchParams.get("name")).toBe("my custom name")
  })
})
