import { describe, test, expect } from "bun:test"
import { isPrivateAddress, assertSafePublicUrl } from "../../utils/ssrf.ts"

describe("Unit: SSRF guard", () => {
  test("private / reserved IPv4 ranges are blocked", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
      expect(isPrivateAddress(ip)).toBe(true)
    }
  })

  test("public IPv4 addresses are allowed", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "192.167.1.1"]) {
      expect(isPrivateAddress(ip)).toBe(false)
    }
  })

  test("private / reserved IPv6 (incl. IPv4-mapped) are blocked", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip)).toBe(true)
    }
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false) // public v6 (1.1.1.1)
  })

  test("non-IP junk is treated as unsafe", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true)
  })

  test("assertSafePublicUrl rejects non-http(s) and private IP literals without DNS", async () => {
    await expect(assertSafePublicUrl("file:///etc/passwd")).rejects.toThrow()
    await expect(assertSafePublicUrl("ftp://example.com/x")).rejects.toThrow()
    await expect(assertSafePublicUrl("http://127.0.0.1/x")).rejects.toThrow(/internal|private/i)
    await expect(assertSafePublicUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/internal|private/i)
    await expect(assertSafePublicUrl("http://[::1]/x")).rejects.toThrow(/internal|private/i)
    await expect(assertSafePublicUrl("not a url")).rejects.toThrow(/invalid url/i)
  })

  test("assertSafePublicUrl allows a public IP literal (no DNS needed)", async () => {
    const u = await assertSafePublicUrl("https://8.8.8.8/favicon.ico")
    expect(u.hostname).toBe("8.8.8.8")
  })
})
