import { describe, test, expect } from "bun:test"
import { buildSslipDomain, isSslipDomain, buildCloudflareTokenUrl, getPublicIP } from "../../lib/cloudflare.ts"

describe("sslip.io helpers", () => {
  test("buildSslipDomain converts IP to sslip.io domain", () => {
    expect(buildSslipDomain("203.0.113.42")).toBe("203-0-113-42.sslip.io")
  })

  test("buildSslipDomain handles IPv4 with dots", () => {
    expect(buildSslipDomain("10.0.0.1")).toBe("10-0-0-1.sslip.io")
  })

  test("isSslipDomain returns true for sslip.io domains", () => {
    expect(isSslipDomain("203-0-113-42.sslip.io")).toBe(true)
  })

  test("isSslipDomain returns false for custom domains", () => {
    expect(isSslipDomain("myserver.example.com")).toBe(false)
  })

  test("isSslipDomain returns false for partial matches", () => {
    expect(isSslipDomain("sslip.io.example.com")).toBe(false)
  })
})

describe("Cloudflare token template URL", () => {
  test("buildCloudflareTokenUrl returns correct URL", () => {
    const url = buildCloudflareTokenUrl()
    expect(url).toContain("https://dash.cloudflare.com/profile/api-tokens")
    expect(url).toContain("permissionGroupKeys")
    expect(url).toContain("zone")
    expect(url).toContain("zone_dns")
    expect(url).toContain("siteio")
  })

  test("buildCloudflareTokenUrl includes custom token name", () => {
    const url = buildCloudflareTokenUrl("my-server token")
    expect(url).toContain("my-server")
  })
})

describe("getPublicIP for sslip.io", () => {
  test("getPublicIP returns a valid IP", async () => {
    const ip = await getPublicIP()
    expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
  })

  test("buildSslipDomain with real IP produces valid domain", async () => {
    const ip = await getPublicIP()
    const domain = buildSslipDomain(ip)
    expect(domain).toMatch(/^\d+-\d+-\d+-\d+\.sslip\.io$/)
    expect(isSslipDomain(domain)).toBe(true)
  })
})
