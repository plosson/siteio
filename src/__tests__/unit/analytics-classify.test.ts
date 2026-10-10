import { describe, expect, test } from "bun:test"
import {
  cleanPath,
  cleanReferrer,
  isBot,
  isPageview,
  parseEntry,
  routerKeys,
  statusClass,
  type AccessLogEntry,
} from "../../lib/agent/analytics/classify"

const entry = (over: Partial<AccessLogEntry> = {}): AccessLogEntry => ({
  StartUTC: "2026-10-10T12:00:03Z",
  RouterName: "siteio-blog@docker",
  RequestMethod: "GET",
  RequestHost: "blog.chuut.com",
  RequestPath: "/",
  DownstreamStatus: 200,
  DownstreamContentSize: 512,
  Duration: 12_000_000,
  ClientHost: "203.0.113.9",
  "request_User-Agent": "Mozilla/5.0 (Macintosh) Firefox/130.0",
  "downstream_Content-Type": "text/html; charset=utf-8",
  ...over,
})

describe("parseEntry", () => {
  test("parses a real Traefik JSON line", () => {
    const line = JSON.stringify({ ...entry(), level: "info", msg: "", time: "2026-10-10T12:00:03Z" })
    expect(parseEntry(line)?.RouterName).toBe("siteio-blog@docker")
  })

  test.each([
    "",
    "not json",
    '{"StartUTC":"2026-10-10T12:00:03Z"',
    "null",
    "[]",
    '"a string"',
    JSON.stringify({ ...entry(), DownstreamStatus: "200" }),
    JSON.stringify({ ...entry(), StartUTC: undefined }),
    JSON.stringify({ ...entry(), RequestPath: 42 }),
    JSON.stringify({ ...entry(), Duration: null }),
  ])("rejects a malformed or incomplete line: %p", (line) => {
    expect(parseEntry(line)).toBeNull()
  })

  test("a line with no router (404 on an unknown host) still parses", () => {
    const { RouterName: _, ...noRouter } = entry()
    expect(parseEntry(JSON.stringify(noRouter))).not.toBeNull()
  })
})

describe("routerKeys", () => {
  test("plain site/app router", () => {
    expect(routerKeys("siteio-blog@docker")).toEqual(["blog"])
  })

  test("canonical router of a site with custom domains: exact key first, then the stripped one", () => {
    expect(routerKeys("siteio-blog-canonical@docker")).toEqual(["blog-canonical", "blog"])
  })

  test("tenant key keeps its -- separator", () => {
    expect(routerKeys("siteio-blog--friend-com@docker")).toEqual(["blog--friend-com"])
  })

  test.each([undefined, "", "api-router@file", "mcp-router@file", "siteio-@docker", "siteio-", "dashboard@internal"])(
    "routers that are not a site or app give no key: %p",
    (name) => {
      expect(routerKeys(name)).toEqual([])
    }
  )
})

describe("isBot", () => {
  test.each([
    undefined,
    "",
    "   ",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36",
    "curl/8.4.0",
    "Wget/1.21",
    "python-requests/2.31",
    "Go-http-client/2.0",
    "facebookexternalhit/1.1",
    "Slackbot-LinkExpanding 1.0",
    "UptimeRobot/2.0",
    "Mozilla/5.0 (compatible; AhrefsBot/7.0)",
    "GPTBot/1.0",
    "bun/1.1.0",
    "undici",
    "PostmanRuntime/7.36",
    "WhatsApp/2.23.20",
    "meta-externalagent/1.1",
    "Mozilla/5.0 (compatible; Google-InspectionTool/1.0)",
  ])("flags %p as a bot", (ua) => {
    expect(isBot(ua)).toBe(true)
  })

  test.each([
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
    "Mozilla/5.0 (Linux; Android 10; CUBOT_X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  ])("lets a real browser through: %p", (ua) => {
    expect(isBot(ua)).toBe(false)
  })
})

describe("cleanPath", () => {
  test.each([
    ["/", "/"],
    ["/posts/1", "/posts/1"],
    ["/posts/1?", "/posts/1"],
    ["/_siteio/edit?code=SECRET123", "/_siteio/edit"],
    ["/callback?code=abc&state=xyz", "/callback"],
    ["/?token=abc&utm_source=hn", "/?utm_source=hn"],
    ["/?utm_source=hn&utm_medium=social&utm_campaign=launch&utm_term=t&utm_content=c&x=1",
      "/?utm_source=hn&utm_medium=social&utm_campaign=launch&utm_term=t&utm_content=c"],
    ["/?UTM_SOURCE=hn", "/"],
    ["/a#frag?code=x", "/a"],
    ["/?utm_source=a?code=SECRET", "/?utm_source=a"],
    ["/?utm_source=a;code=SECRET", "/?utm_source=a"],
    ["/?utm_source=a%23x", "/?utm_source=a%23x"],
    ["/?utm_source=", "/?utm_source="],
    ["/?utm_source=a?b&utm_medium=m;c", "/?utm_source=a&utm_medium=m"],
  ])("%p → %p", (input, expected) => {
    expect(cleanPath(input)).toBe(expected)
  })

  test("a kept utm value is capped at 100 characters", () => {
    expect(cleanPath(`/?utm_source=${"x".repeat(500)}`)).toBe(`/?utm_source=${"x".repeat(100)}`)
  })

  test("never throws on a malformed percent-encoding", () => {
    expect(cleanPath("/%E0%A4%A?code=1")).toBe("/%E0%A4%A")
  })
})

describe("cleanReferrer", () => {
  test.each<[string, string | undefined]>([
    ["https://app.example/cb?code=SECRET&state=x", "https://app.example/cb"],
    ["https://u:p@x.example/a?utm_source=hn&t=1#f", "https://x.example/a?utm_source=hn"],
    ["https://ref.example/", "https://ref.example/"],
    ["http://ref.example:8080/p#frag", "http://ref.example:8080/p"],
    ["not a url", undefined],
    ["", undefined],
    ["javascript:alert(1)", undefined],
    ["android-app://com.google", undefined],
    ["ftp://x.example/a", undefined],
    ["https://x.example/a?utm_source=a?code=SECRET", "https://x.example/a?utm_source=a"],
  ])("%p → %p", (input, expected) => {
    expect(cleanReferrer(input)).toBe(expected)
  })
})

describe("isPageview", () => {
  test("a browser GET of an HTML page is a pageview", () => {
    expect(isPageview(entry())).toBe(true)
  })

  test.each<[string, Partial<AccessLogEntry>]>([
    ["HEAD", { RequestMethod: "HEAD" }],
    ["POST", { RequestMethod: "POST" }],
    ["304 without Sec-Fetch-Dest", { DownstreamStatus: 304 }],
    ["304 for an image", { DownstreamStatus: 304, "request_Sec-Fetch-Dest": "image" }],
    ["304 document by a bot", { DownstreamStatus: 304, "request_Sec-Fetch-Dest": "document", "request_User-Agent": "Googlebot/2.1" }],
    ["304 document on the editor", { DownstreamStatus: 304, "request_Sec-Fetch-Dest": "document", RequestPath: "/_siteio/edit" }],
    ["304 document via POST", { DownstreamStatus: 304, "request_Sec-Fetch-Dest": "document", RequestMethod: "POST" }],
    ["200 non-HTML document dest", { "downstream_Content-Type": "image/png", "request_Sec-Fetch-Dest": "document" }],
    ["404", { DownstreamStatus: 404 }],
    ["500", { DownstreamStatus: 500 }],
    ["JSON", { "downstream_Content-Type": "application/json" }],
    ["CSS", { "downstream_Content-Type": "text/css" }],
    ["no content type", { "downstream_Content-Type": undefined }],
    ["bot", { "request_User-Agent": "Googlebot/2.1" }],
    ["siteio editor", { RequestPath: "/_siteio/edit" }],
    ["MCP", { RequestPath: "/mcp/sse" }],
    ["PocketBase API", { RequestPath: "/api/collections/posts/records" }],
    ["well-known", { RequestPath: "/.well-known/oauth-authorization-server" }],
  ])("not a pageview: %s", (_, over) => {
    expect(isPageview(entry(over))).toBe(false)
  })

  test("a path that merely starts with the letters 'api' is still a pageview", () => {
    expect(isPageview(entry({ RequestPath: "/apiary" }))).toBe(true)
  })

  test("a revalidated 304 of a document navigation is a pageview", () => {
    expect(isPageview(entry({ DownstreamStatus: 304, "downstream_Content-Type": undefined, "request_Sec-Fetch-Dest": "document" }))).toBe(true)
  })

  test("content type is matched case-insensitively", () => {
    expect(isPageview(entry({ "downstream_Content-Type": "Text/HTML" }))).toBe(true)
  })
})

describe("statusClass", () => {
  test.each([[200, "2xx"], [204, "2xx"], [301, "3xx"], [404, "4xx"], [499, "4xx"], [503, "5xx"]] as const)(
    "%p → %p",
    (status, cls) => {
      expect(statusClass(status)).toBe(cls)
    }
  )

  test.each([0, 100, 600, -1, 200.5])("%p has no class", (status) => {
    expect(statusClass(status)).toBeNull()
  })
})
