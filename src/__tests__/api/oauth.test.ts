import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { randomBytes, createHash } from "crypto"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, ApiResponse, ShareGrantCreated } from "../../types.ts"

function makeServer(dataDir: string, runtime: FakeRuntime): AgentServer {
  const config: AgentConfig = {
    apiKey: "test-key", dataDir, domain: "example.com",
    maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
  }
  return new AgentServer(config, runtime)
}

const AUTH = { "X-API-Key": "test-key" }
const ZIPH = { ...AUTH, "Content-Type": "application/zip" }
const JSONH = { ...AUTH, "Content-Type": "application/json" }
const FORMH = { "Content-Type": "application/x-www-form-urlencoded" }
const REDIRECT = "https://claude.ai/api/mcp/auth_callback"

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

describe("API: per-site OAuth authorization server", () => {
  let dataDir: string
  let runtime: FakeRuntime
  let server: AgentServer
  const HOST = "blog.example.com"

  const on = (req: Request, host = HOST) => server.handleRequestForTest(req, host)

  const mintCode = async (name = "blog", body: Record<string, unknown> = {}): Promise<string> => {
    const res = await server.handleRequestForTest(
      new Request(`http://x/sites/${name}/grants`, { method: "POST", headers: JSONH, body: JSON.stringify(body) })
    )
    return ((await res.json()) as ApiResponse<ShareGrantCreated>).data!.code
  }

  const register = async (host = HOST): Promise<string> => {
    const res = await on(
      new Request("http://x/mcp/oauth/register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Claude" }),
      }),
      host
    )
    return ((await res.json()) as { client_id: string }).client_id
  }

  const authorize = (params: Record<string, string>, host = HOST) =>
    on(new Request("http://x/mcp/oauth/authorize", { method: "POST", headers: FORMH, body: new URLSearchParams(params).toString() }), host)

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-oauth-api-"))
    runtime = new FakeRuntime()
    server = makeServer(dataDir, runtime)
    await server.handleRequestForTest(
      new Request("http://x/sites/blog", {
        method: "POST", headers: ZIPH,
        body: zipSync({ "public/index.html": new TextEncoder().encode("<h1>hi</h1>") }),
      })
    )
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  test("protected-resource metadata points at the site host, never api.", async () => {
    const res = await on(new Request("http://x/.well-known/oauth-protected-resource", { method: "GET" }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { resource: string; authorization_servers: string[] }
    expect(body.resource).toBe("https://blog.example.com/mcp")
    expect(body.authorization_servers).toEqual(["https://blog.example.com"])
    expect(JSON.stringify(body)).not.toContain("api.example.com")
  })

  test("authorization-server metadata advertises the per-site endpoints + PKCE", async () => {
    const res = await on(new Request("http://x/.well-known/oauth-authorization-server", { method: "GET" }))
    const body = (await res.json()) as Record<string, unknown>
    expect(body.issuer).toBe("https://blog.example.com")
    expect(body.authorization_endpoint).toBe("https://blog.example.com/mcp/oauth/authorize")
    expect(body.token_endpoint).toBe("https://blog.example.com/mcp/oauth/token")
    expect(body.registration_endpoint).toBe("https://blog.example.com/mcp/oauth/register")
    expect(body.code_challenge_methods_supported).toEqual(["S256"])
  })

  test("metadata is refused on the api host (never exposed there)", async () => {
    const res = await on(
      new Request("http://x/.well-known/oauth-authorization-server", { method: "GET" }),
      "api.example.com"
    )
    expect(res.status).toBe(404)
  })

  test("dynamic client registration issues a client_id", async () => {
    const res = await on(
      new Request("http://x/mcp/oauth/register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Claude" }),
      })
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { client_id: string; redirect_uris: string[] }
    expect(body.client_id).toStartWith("cid_")
    expect(body.redirect_uris).toEqual([REDIRECT])
  })

  test("registration requires an https redirect_uri", async () => {
    const res = await on(
      new Request("http://x/mcp/oauth/register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [] }),
      })
    )
    expect(res.status).toBe(400)
  })

  test("authorize GET renders the code-entry consent page", async () => {
    const clientId = await register()
    const { challenge } = pkce()
    const qs = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
      code_challenge: challenge, code_challenge_method: "S256", state: "s1",
    })
    const res = await on(new Request(`http://x/mcp/oauth/authorize?${qs}`, { method: "GET" }))
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/html")
    const html = await res.text()
    expect(html).toContain("Enter the share code")
    expect(html).toContain("blog")
  })

  test("full dance: authorize with a valid code -> token -> access token", async () => {
    const code = await mintCode()
    const clientId = await register()
    const { verifier, challenge } = pkce()

    const authRes = await authorize({
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
      code_challenge: challenge, code_challenge_method: "S256", state: "s1", code,
    })
    expect(authRes.status).toBe(302)
    const loc = new URL(authRes.headers.get("Location")!)
    expect(loc.origin + loc.pathname).toBe(REDIRECT)
    expect(loc.searchParams.get("state")).toBe("s1")
    const authCode = loc.searchParams.get("code")!
    expect(authCode).toStartWith("ac_")

    const tokRes = await on(
      new Request("http://x/mcp/oauth/token", {
        method: "POST", headers: FORMH,
        body: new URLSearchParams({
          grant_type: "authorization_code", code: authCode, redirect_uri: REDIRECT,
          client_id: clientId, code_verifier: verifier,
        }).toString(),
      })
    )
    expect(tokRes.status).toBe(200)
    const tok = (await tokRes.json()) as { access_token: string; token_type: string; expires_in: number }
    expect(tok.access_token).toStartWith("at_")
    expect(tok.token_type).toBe("Bearer")
    expect(tok.expires_in).toBeGreaterThan(0)
  })

  test("authorize rejects an invalid share code", async () => {
    const clientId = await register()
    const { challenge } = pkce()
    const res = await authorize({
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
      code_challenge: challenge, code_challenge_method: "S256", code: "grt_bogus-code-value",
    })
    expect(res.status).toBe(401)
    expect(await res.text()).toContain("invalid")
  })

  test("a code for another site cannot authorize on this host", async () => {
    await server.handleRequestForTest(
      new Request("http://x/sites/shop", {
        method: "POST", headers: ZIPH,
        body: zipSync({ "public/index.html": new TextEncoder().encode("<h1>shop</h1>") }),
      })
    )
    const shopCode = await mintCode("shop")
    const clientId = await register() // registered on blog host
    const { challenge } = pkce()
    // Present the shop code on blog's authorize endpoint.
    const res = await authorize({
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
      code_challenge: challenge, code_challenge_method: "S256", code: shopCode,
    })
    expect(res.status).toBe(401)
  })

  test("authorize rejects an unregistered redirect_uri", async () => {
    const code = await mintCode()
    const clientId = await register()
    const { challenge } = pkce()
    const res = await authorize({
      response_type: "code", client_id: clientId, redirect_uri: "https://evil.example/cb",
      code_challenge: challenge, code_challenge_method: "S256", code,
    })
    expect(res.status).toBe(400)
  })

  test("token exchange fails on a bad PKCE verifier", async () => {
    const code = await mintCode()
    const clientId = await register()
    const { challenge } = pkce()
    const authRes = await authorize({
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
      code_challenge: challenge, code_challenge_method: "S256", code,
    })
    const authCode = new URL(authRes.headers.get("Location")!).searchParams.get("code")!
    const tokRes = await on(
      new Request("http://x/mcp/oauth/token", {
        method: "POST", headers: FORMH,
        body: new URLSearchParams({
          grant_type: "authorization_code", code: authCode, redirect_uri: REDIRECT,
          client_id: clientId, code_verifier: "the-wrong-verifier",
        }).toString(),
      })
    )
    expect(tokRes.status).toBe(400)
    expect((await tokRes.json() as { error: string }).error).toBe("invalid_grant")
  })

  test("an authorization code is single-use", async () => {
    const code = await mintCode()
    const clientId = await register()
    const { verifier, challenge } = pkce()
    const authRes = await authorize({
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
      code_challenge: challenge, code_challenge_method: "S256", code,
    })
    const authCode = new URL(authRes.headers.get("Location")!).searchParams.get("code")!
    const exchange = () =>
      on(new Request("http://x/mcp/oauth/token", {
        method: "POST", headers: FORMH,
        body: new URLSearchParams({
          grant_type: "authorization_code", code: authCode, redirect_uri: REDIRECT,
          client_id: clientId, code_verifier: verifier,
        }).toString(),
      }))
    expect((await exchange()).status).toBe(200)
    expect((await exchange()).status).toBe(400) // replay rejected
  })

  test("CORS preflight is answered", async () => {
    const res = await on(new Request("http://x/mcp/oauth/token", { method: "OPTIONS" }))
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
  })
})
