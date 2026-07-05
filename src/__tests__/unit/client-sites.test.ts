import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { SiteioClient } from "../../lib/client.ts"

const realFetch = globalThis.fetch

describe("Unit: SiteioClient site methods", () => {
  let client: SiteioClient
  beforeEach(() => {
    client = new SiteioClient({ apiUrl: "http://agent", apiKey: "k" })
  })
  afterEach(() => { globalThis.fetch = realFetch })

  test("deploySite POSTs the zip and returns info", async () => {
    let captured: { url: string; method?: string; headers: Record<string, string> } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, method: init.method, headers: init.headers as Record<string, string> }
      return new Response(JSON.stringify({ success: true, data: { name: "blog", url: "https://blog.example.com" } }), { status: 200 })
    }) as typeof fetch

    const info = await client.deploySite("blog", new Uint8Array([1, 2, 3]), { deployedBy: "ada" })
    expect(info.name).toBe("blog")
    expect(captured!.url).toBe("http://agent/sites/blog")
    expect(captured!.method).toBe("POST")
    expect(captured!.headers["Content-Type"]).toBe("application/zip")
    expect(captured!.headers["X-Deployed-By"]).toBe("ada")
  })

  test("getSiteAdmin returns credentials", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: true, data: { email: "a@b.co", password: "pw", adminUrl: "https://blog.example.com/_/" } }), { status: 200 })
    ) as unknown as typeof fetch
    const admin = await client.getSiteAdmin("blog")
    expect(admin.email).toBe("a@b.co")
  })
})
