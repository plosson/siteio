import { describe, test, expect } from "bun:test"
import { requestIp } from "../../lib/agent/request-ip.ts"

const r = (headers: Record<string, string>) => new Request("http://x/", { headers })
const CF_EDGE = "172.64.1.1"

describe("Unit: requestIp", () => {
  test("a public peer is the client; its headers are ignored", () => {
    expect(requestIp(r({ "X-Forwarded-For": "1.2.3.4" }), "8.8.8.8")).toBe("8.8.8.8")
  })

  test("behind Traefik (private peer) the last X-Forwarded-For entry is the client", () => {
    expect(requestIp(r({ "X-Forwarded-For": "6.6.6.6, 1.2.3.4" }), "172.17.0.1")).toBe("1.2.3.4")
    expect(requestIp(r({ "X-Forwarded-For": "1.2.3.4" }), "::ffff:172.18.0.1")).toBe("1.2.3.4")
  })

  test("no or junk X-Forwarded-For falls back to the peer", () => {
    expect(requestIp(r({}), "127.0.0.1")).toBe("127.0.0.1")
    expect(requestIp(r({ "X-Forwarded-For": "not-an-ip" }), "10.0.0.2")).toBe("10.0.0.2")
  })

  test("CF-Connecting-IP counts only when Traefik saw a Cloudflare edge", () => {
    expect(requestIp(r({ "X-Forwarded-For": CF_EDGE, "CF-Connecting-IP": "9.9.9.9" }), "172.17.0.1")).toBe("9.9.9.9")
    expect(requestIp(r({ "X-Forwarded-For": "1.2.3.4", "CF-Connecting-IP": "9.9.9.9" }), "172.17.0.1")).toBe("1.2.3.4")
    expect(requestIp(r({ "X-Forwarded-For": CF_EDGE, "CF-Connecting-IP": "junk" }), "172.17.0.1")).toBe(CF_EDGE)
  })
})
