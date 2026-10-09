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
      { key: "dns", type: "edit" },
      { key: "account_settings", type: "read" },
      { key: "registrar", type: "edit" },
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

describe("Install URLs", () => {
  test("the agent installer downloads from houlahop.com", async () => {
    const { INSTALL_SCRIPT_URL } = await import("../../commands/agent/install.ts")
    expect(INSTALL_SCRIPT_URL).toBe("https://houlahop.com/siteio/install")
    expect(INSTALL_SCRIPT_URL).not.toContain("siteio.houlahop.com")
  })

  test("no source file still points at the retired siteio.houlahop.com", async () => {
    const { Glob } = await import("bun")
    const root = new URL("../../", import.meta.url).pathname
    const offenders: string[] = []
    for await (const file of new Glob("**/*.ts").scan({ cwd: root })) {
      if (file.startsWith("__tests__/")) continue
      if ((await Bun.file(root + file).text()).includes("siteio.houlahop.com")) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})
