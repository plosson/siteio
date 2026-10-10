import { describe, expect, test } from "bun:test"
import { buildBatch, percentile, type Resolve } from "../../lib/agent/analytics/batch"
import type { AccessLogEntry } from "../../lib/agent/analytics/classify"

const BROWSER = "Mozilla/5.0 (Macintosh) Firefox/130.0"

const entry = (over: Partial<AccessLogEntry> = {}): AccessLogEntry => ({
  StartUTC: "2026-10-10T12:00:03Z",
  RouterName: "siteio-blog@docker",
  RequestMethod: "GET",
  RequestHost: "blog.chuut.com",
  RequestPath: "/",
  DownstreamStatus: 200,
  DownstreamContentSize: 100,
  Duration: 10_000_000,
  ClientHost: "203.0.113.9",
  "request_User-Agent": BROWSER,
  "downstream_Content-Type": "text/html",
  ...over,
})

const known: Record<string, ReturnType<Resolve>> = {
  blog: { kind: "site", name: "blog", owner: "pierre" },
  "blog--friend-com": { kind: "site", name: "blog--friend-com" },
  web: { kind: "app", name: "web" },
}
const resolve: Resolve = (key) => known[key] ?? null

describe("buildBatch", () => {
  test("no entries → null (nothing to send)", () => {
    expect(buildBatch("chuut.com", [], resolve)).toBeNull()
  })

  test("only unknown routers → null", () => {
    const entries = [
      entry({ RouterName: "api-router@file" }),
      entry({ RouterName: undefined }),
      entry({ RouterName: "siteio-deleted@docker" }),
    ]
    expect(buildBatch("chuut.com", entries, resolve)).toBeNull()
  })

  test("a pageview carries owner, cleaned path, referrer, ip and ms duration", () => {
    const batch = buildBatch(
      "chuut.com",
      [entry({ RequestPath: "/p?code=SECRET&utm_source=hn", "request_Referer": "https://hn.example/", Duration: 12_400_000 })],
      resolve
    )!
    expect(batch.version).toBe(1)
    expect(batch.agent).toBe("chuut.com")
    expect(batch.pageviews).toEqual([
      {
        ts: "2026-10-10T12:00:03.000Z",
        kind: "site",
        name: "blog",
        owner: "pierre",
        host: "blog.chuut.com",
        path: "/p?utm_source=hn",
        referrer: "https://hn.example/",
        userAgent: BROWSER,
        ip: "203.0.113.9",
        status: 200,
        durationMs: 12,
      },
    ])
    expect(JSON.stringify(batch)).not.toContain("SECRET")
  })

  test("behind Cloudflare the pageview carries the visitor IP, not Cloudflare's", () => {
    const batch = buildBatch(
      "chuut.com",
      [entry({ ClientHost: "172.70.1.2", "request_Cf-Connecting-Ip": "198.51.100.7" })],
      resolve
    )!
    expect(batch.pageviews[0]!.ip).toBe("198.51.100.7")
  })

  test("a canonical router resolves to its site", () => {
    const batch = buildBatch("chuut.com", [entry({ RouterName: "siteio-blog-canonical@docker" })], resolve)!
    expect(batch.traffic.map((t) => t.name)).toEqual(["blog"])
  })

  test("tenant and app keys resolve; apps have no owner", () => {
    const batch = buildBatch(
      "chuut.com",
      [entry({ RouterName: "siteio-blog--friend-com@docker" }), entry({ RouterName: "siteio-web@docker" })],
      resolve
    )!
    const byName = Object.fromEntries(batch.traffic.map((t) => [t.name, t]))
    expect(byName["blog--friend-com"]!.kind).toBe("site")
    expect(byName.web!.kind).toBe("app")
    expect("owner" in byName.web!).toBe(false)
  })

  test("traffic counts every request, bots included; pageviews exclude bots and assets", () => {
    const entries = [
      entry(),
      entry({ "request_User-Agent": "Googlebot/2.1" }),
      entry({ RequestPath: "/app.css", "downstream_Content-Type": "text/css", DownstreamContentSize: 900 }),
      entry({ DownstreamStatus: 404 }),
      entry({ DownstreamStatus: 503 }),
      entry({ DownstreamStatus: 301 }),
      entry({ DownstreamStatus: 0 }), // client went away: counted as a request, no class
    ]
    const batch = buildBatch("chuut.com", entries, resolve)!
    expect(batch.pageviews).toHaveLength(1)
    const t = batch.traffic[0]!
    expect(t.requests).toBe(7)
    expect(t.bots).toBe(1)
    expect(t.bytes).toBe(100 * 6 + 900)
    expect(t.status).toEqual({ "2xx": 3, "3xx": 1, "4xx": 1, "5xx": 1 })
  })

  test("from/to span the batch even when lines are out of order", () => {
    const batch = buildBatch(
      "chuut.com",
      [entry({ StartUTC: "2026-10-10T12:00:30Z" }), entry({ StartUTC: "2026-10-10T12:00:01Z" }), entry({ StartUTC: "2026-10-10T12:00:59Z" })],
      resolve
    )!
    expect(batch.from).toBe("2026-10-10T12:00:01.000Z")
    expect(batch.to).toBe("2026-10-10T12:00:59.000Z")
  })

  test("an entry with an unparseable StartUTC is skipped, not sent as Invalid Date", () => {
    const batch = buildBatch("chuut.com", [entry({ StartUTC: "garbage" }), entry()], resolve)!
    expect(batch.traffic[0]!.requests).toBe(1)
    expect(JSON.stringify(batch)).not.toContain("Invalid")
  })

  test("resolve is called once per key, not once per line", () => {
    let calls = 0
    const counting: Resolve = (key) => {
      calls++
      return resolve(key)
    }
    buildBatch("chuut.com", Array.from({ length: 500 }, () => entry()), counting)
    expect(calls).toBe(1)
  })

  test("empty referrer and user agent are omitted, not sent as empty strings", () => {
    const batch = buildBatch("chuut.com", [entry({ "request_Referer": "" })], resolve)!
    expect("referrer" in batch.pageviews[0]!).toBe(false)
  })
})

describe("percentile", () => {
  test("empty → 0", () => {
    expect(percentile([], 0.5)).toBe(0)
  })
  test("single value", () => {
    expect(percentile([7], 0.95)).toBe(7)
  })
  test("nearest-rank on sorted input", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(xs, 0.5)).toBe(50)
    expect(percentile(xs, 0.95)).toBe(95)
  })
})
