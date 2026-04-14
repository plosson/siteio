import { describe, test, expect, afterEach, mock } from "bun:test"
import { discoverOIDC } from "../../config/oidc-discovery"

describe("Unit: OIDC Discovery", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("fetches .well-known/openid-configuration and returns canonical issuer", async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          issuer: "https://accounts.google.com",
          end_session_endpoint: undefined,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    ) as unknown as typeof fetch

    const result = await discoverOIDC("https://accounts.google.com")
    expect(result.issuer).toBe("https://accounts.google.com")
    expect(result.endSessionEndpoint).toBeUndefined()
  })

  test("captures end_session_endpoint when provider advertises it", async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          issuer: "https://tenant.eu.auth0.com/",
          end_session_endpoint: "https://tenant.eu.auth0.com/oidc/logout",
        }),
        { status: 200 }
      )
    ) as unknown as typeof fetch

    const result = await discoverOIDC("https://tenant.eu.auth0.com")
    expect(result.issuer).toBe("https://tenant.eu.auth0.com/")
    expect(result.endSessionEndpoint).toBe("https://tenant.eu.auth0.com/oidc/logout")
  })

  test("handles trailing slash in input URL", async () => {
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://accounts.google.com/.well-known/openid-configuration")
      return new Response(JSON.stringify({ issuer: "https://accounts.google.com" }), { status: 200 })
    }) as unknown as typeof fetch

    await discoverOIDC("https://accounts.google.com/")
  })

  test("throws a helpful error on non-200 response", async () => {
    globalThis.fetch = mock(async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch
    await expect(discoverOIDC("https://broken.example.com")).rejects.toThrow(/discovery failed/i)
  })

  test("throws a helpful error when issuer field is missing", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ foo: "bar" }), { status: 200 })
    ) as unknown as typeof fetch
    await expect(discoverOIDC("https://weird.example.com")).rejects.toThrow(/missing issuer/i)
  })

  test("propagates network errors from fetch", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    await expect(discoverOIDC("https://unreachable.example.com")).rejects.toThrow(/fetch failed/i)
  })

  test("throws a helpful error when response body is non-JSON", async () => {
    globalThis.fetch = mock(async () =>
      new Response("<html>oops</html>", { status: 200 })
    ) as unknown as typeof fetch
    await expect(discoverOIDC("https://notjson.example.com")).rejects.toThrow(/non-JSON body/i)
  })

  test("throws a helpful error when issuer field is an empty string", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ issuer: "" }), { status: 200 })
    ) as unknown as typeof fetch
    await expect(discoverOIDC("https://empty.example.com")).rejects.toThrow(/missing issuer/i)
  })
})
