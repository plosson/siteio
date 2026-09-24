import { describe, test, expect } from "bun:test"
import { checkUrl, waitForUrl } from "../../lib/verification"

const respond = (status: number, body = "") => (async () => new Response(body, { status })) as unknown as typeof fetch
const fail = (code: string, message: string) =>
  (async () => {
    throw Object.assign(new TypeError(message), { code })
  }) as unknown as typeof fetch

describe("Unit: checkUrl", () => {
  test("2xx, 3xx and app-level 4xx mean the app is served", async () => {
    expect(await checkUrl("https://x", 1000, respond(200))).toEqual({ ok: true, status: 200 })
    expect(await checkUrl("https://x", 1000, respond(302))).toEqual({ ok: true, status: 302 })
    expect(await checkUrl("https://x", 1000, respond(401))).toEqual({ ok: true, status: 401 })
  })

  test("Traefik's own 404 means no route, not a served app", async () => {
    const r = await checkUrl("https://x", 1000, respond(404, "404 page not found\n"))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain("no route")
  })

  test("an app's own 404 page counts as served", async () => {
    expect((await checkUrl("https://x", 1000, respond(404, "<h1>Not here</h1>"))).ok).toBe(true)
  })

  test("gateway errors mean the proxy cannot reach the app", async () => {
    for (const status of [502, 503, 504]) {
      const r = await checkUrl("https://x", 1000, respond(status))
      expect(!r.ok && r.reason).toContain("cannot reach the app")
    }
  })

  test("other 5xx are failures that name the status", async () => {
    const r = await checkUrl("https://x", 1000, respond(500))
    expect(r).toEqual({ ok: false, status: 500, reason: "the app answers HTTP 500" })
  })

  test("Traefik's default certificate is reported as a TLS problem", async () => {
    const r = await checkUrl("https://x", 1000, fail("UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "unable to get local issuer certificate"))
    expect(!r.ok && r.reason).toContain("TLS certificate not trusted yet")
  })

  test("self-signed and expired certificates are TLS problems too", async () => {
    for (const code of ["DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED"]) {
      const r = await checkUrl("https://x", 1000, fail(code, "bad cert"))
      expect(!r.ok && r.reason).toContain("TLS")
    }
  })

  test("DNS failure is reported plainly", async () => {
    const r = await checkUrl("https://x", 1000, fail("ENOTFOUND", "getaddrinfo ENOTFOUND x"))
    expect(r).toEqual({ ok: false, reason: "DNS does not resolve for this host" })
  })

  test("does not follow redirects (a redirect loop must not hang the check)", async () => {
    let init: RequestInit | undefined
    await checkUrl("https://x", 1000, (async (_u: string, i: RequestInit) => ((init = i), new Response("", { status: 301 }))) as unknown as typeof fetch)
    expect(init?.redirect).toBe("manual")
  })
})

describe("Unit: waitForUrl", () => {
  function clock() {
    let t = 0
    return { now: () => t, sleepFn: async (ms: number) => void (t += ms) }
  }

  test("retries until the app is served", async () => {
    const statuses = [502, 502, 200]
    let i = 0
    const fetchFn = (async () => new Response("", { status: statuses[i++]! })) as unknown as typeof fetch
    const r = await waitForUrl("https://x", { timeoutMs: 60, intervalMs: 3, fetchFn, ...clock() })
    expect(r).toEqual({ success: true, attempts: 3, status: 200 })
  })

  test("gives up at the timeout and reports the last reason", async () => {
    const r = await waitForUrl("https://x", { timeoutMs: 10, intervalMs: 3, fetchFn: respond(503), ...clock() })
    expect(r.success).toBe(false)
    expect(r.error).toContain("HTTP 503")
    expect(r.attempts).toBe(4) // t=0,3,6,9 then 12 > 10
  })

  test("a zero overall timeout does not abort the single request", async () => {
    let aborted: boolean | undefined
    const fetchFn = (async (_u: string, init: RequestInit) => {
      await new Promise((r) => setTimeout(r, 5))
      aborted = init.signal?.aborted
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch
    const r = await waitForUrl("https://x", { timeoutMs: 0, fetchFn, ...clock() })
    expect(aborted).toBe(false)
    expect(r.success).toBe(true)
  })

  test("a zero timeout still makes one attempt", async () => {
    const r = await waitForUrl("https://x", { timeoutMs: 0, intervalMs: 3, fetchFn: respond(200), ...clock() })
    expect(r).toEqual({ success: true, attempts: 1, status: 200 })
  })
})
