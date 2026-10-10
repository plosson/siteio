import { describe, expect, test } from "bun:test"
import { clientIp, isCloudflareIp, parseIp } from "../../lib/agent/analytics/client-ip"
import type { AccessLogEntry } from "../../lib/agent/analytics/classify"

const entry = (over: Partial<AccessLogEntry> = {}): AccessLogEntry => ({
  StartUTC: "2026-10-10T12:00:03Z",
  RouterName: "siteio-blog@docker",
  RequestMethod: "GET",
  RequestHost: "blog.chuut.com",
  RequestPath: "/",
  DownstreamStatus: 200,
  DownstreamContentSize: 10,
  Duration: 1_000_000,
  ClientHost: "203.0.113.9",
  ...over,
})

describe("parseIp", () => {
  test.each(["1.2.3.4", "0.0.0.0", "255.255.255.255", "::", "::1", "2606:4700::1", "2606:4700:0:0:0:0:0:1", "::ffff:1.2.3.4"])(
    "accepts %p",
    (ip) => {
      expect(parseIp(ip)).not.toBeNull()
    }
  )

  test.each([
    "",
    " ",
    "1.2.3",
    "1.2.3.4.5",
    "256.1.1.1",
    "1.2.3.-1",
    "01.2.3.4x",
    "1.2.3.4, 5.6.7.8", // a list, as X-Forwarded-For would carry
    "1:2:3:4:5:6:7:8:9",
    "2606:4700::1::2",
    "gggg::1",
    "12345::1",
    "[2606:4700::1]",
    "localhost",
    "1.2.3.4:443",
  ])("rejects %p", (ip) => {
    expect(parseIp(ip)).toBeNull()
  })

  test("IPv4-mapped IPv6 is treated as IPv4", () => {
    expect(parseIp("::ffff:1.2.3.4")).toEqual(parseIp("1.2.3.4"))
  })
})

describe("isCloudflareIp", () => {
  test.each(["173.245.48.1", "104.16.0.0", "104.23.255.255", "172.70.1.2", "2606:4700::1", "2a06:98c0::1", "::ffff:162.158.1.1"])(
    "%p is Cloudflare",
    (ip) => {
      expect(isCloudflareIp(ip)).toBe(true)
    }
  )

  test.each(["104.15.255.255", "104.32.0.0", "203.0.113.9", "10.0.0.1", "127.0.0.1", "2606:4701::1", "::1", "", "garbage"])(
    "%p is not Cloudflare",
    (ip) => {
      expect(isCloudflareIp(ip)).toBe(false)
    }
  )
})

describe("clientIp", () => {
  test("direct visitor, no header → ClientHost", () => {
    expect(clientIp(entry())).toBe("203.0.113.9")
  })

  test("through Cloudflare → the header's visitor IP", () => {
    expect(clientIp(entry({ ClientHost: "172.70.1.2", "request_Cf-Connecting-Ip": "198.51.100.7" }))).toBe("198.51.100.7")
  })

  test("through Cloudflare over IPv6 → the header's visitor IP", () => {
    expect(clientIp(entry({ ClientHost: "2606:4700::6810:1", "request_Cf-Connecting-Ip": "2001:db8::5" }))).toBe("2001:db8::5")
  })

  test("SPOOF: header sent straight to the origin by a non-Cloudflare IP is ignored", () => {
    expect(clientIp(entry({ ClientHost: "203.0.113.9", "request_Cf-Connecting-Ip": "8.8.8.8" }))).toBe("203.0.113.9")
  })

  test.each(["", "   ", "not-an-ip", "1.2.3.4, 5.6.7.8", "999.1.1.1"])(
    "through Cloudflare with a bad header %p → falls back to ClientHost",
    (bad) => {
      expect(clientIp(entry({ ClientHost: "172.70.1.2", "request_Cf-Connecting-Ip": bad }))).toBe("172.70.1.2")
    }
  )

  test("surrounding whitespace in the header is trimmed", () => {
    expect(clientIp(entry({ ClientHost: "172.70.1.2", "request_Cf-Connecting-Ip": " 198.51.100.7 " }))).toBe("198.51.100.7")
  })
})
