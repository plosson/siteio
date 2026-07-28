import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync, unzipSync } from "fflate"
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
function toolText(body: { result?: { content?: { text: string }[]; isError?: boolean } }): string {
  return body.result?.content?.[0]?.text ?? ""
}

describe("API: MCP surfaces — /mcp (editing) and /cli (bridge), shared OAuth", () => {
  let dataDir: string
  let runtime: FakeRuntime
  let server: AgentServer
  const HOST = "blog.example.com"

  const on = (req: Request, host = HOST) => server.handleRequestForTest(req, host)

  const deploySite = (name: string, files: Record<string, string>) =>
    server.handleRequestForTest(
      new Request(`http://x/sites/${name}`, {
        method: "POST", headers: ZIPH,
        body: zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)]))),
      })
    )

  const mintCode = async (name: string, body: Record<string, unknown> = {}): Promise<string> => {
    const res = await server.handleRequestForTest(
      new Request(`http://x/sites/${name}/grants`, { method: "POST", headers: JSONH, body: JSON.stringify(body) })
    )
    return ((await res.json()) as ApiResponse<ShareGrantCreated>).data!.code
  }

  // Run the OAuth share-code dance once (on `host`) → a bearer usable on BOTH
  // surfaces. Grants are minted on the api host; the dance runs on the site host.
  const connect = async (name: string, grantBody: Record<string, unknown> = {}, host = HOST): Promise<string> => {
    const code = await mintCode(name, grantBody)
    const reg = await on(
      new Request("http://x/mcp/oauth/register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT] }),
      }),
      host
    )
    const clientId = ((await reg.json()) as { client_id: string }).client_id
    const { verifier, challenge } = pkce()
    const authRes = await on(
      new Request("http://x/mcp/oauth/authorize", {
        method: "POST", headers: FORMH,
        body: new URLSearchParams({
          response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
          code_challenge: challenge, code_challenge_method: "S256", code,
        }).toString(),
      }),
      host
    )
    const authCode = new URL(authRes.headers.get("Location")!).searchParams.get("code")!
    const tokRes = await on(
      new Request("http://x/mcp/oauth/token", {
        method: "POST", headers: FORMH,
        body: new URLSearchParams({
          grant_type: "authorization_code", code: authCode, redirect_uri: REDIRECT,
          client_id: clientId, code_verifier: verifier,
        }).toString(),
      }),
      host
    )
    return ((await tokRes.json()) as { access_token: string }).access_token
  }

  const rpc = (endpoint: "/mcp" | "/cli", bearer: string, message: unknown, host = HOST) =>
    on(
      new Request(`http://x${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
        body: JSON.stringify(message),
      }),
      host
    )
  const call = async (endpoint: "/mcp" | "/cli", bearer: string, name: string, args: Record<string, unknown> = {}, host = HOST) => {
    const res = await rpc(endpoint, bearer, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, host)
    return { status: res.status, body: (await res.json()) as { result?: { content?: { text: string }[]; isError?: boolean } } }
  }
  const listTools = async (endpoint: "/mcp" | "/cli", bearer: string) => {
    const res = await rpc(endpoint, bearer, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    return ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name).sort()
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-mcp-"))
    runtime = new FakeRuntime()
    server = makeServer(dataDir, runtime)
    await deploySite("blog", { "public/index.html": "<h1>original</h1>", "pb_migrations/1_init.js": "// schema" })
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  // --- Auth (shared) ---

  test("unauthenticated /mcp and /cli each 401 to their own protected-resource", async () => {
    const mcp = await on(new Request("http://x/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))
    expect(mcp.status).toBe(401)
    expect(mcp.headers.get("WWW-Authenticate")).toContain("/.well-known/oauth-protected-resource/mcp")
    const cli = await on(new Request("http://x/cli", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))
    expect(cli.status).toBe(401)
    expect(cli.headers.get("WWW-Authenticate")).toContain("/.well-known/oauth-protected-resource/cli")
  })

  test("protected-resource metadata differs per surface but names the same auth server", async () => {
    const mcp = (await (await on(new Request("http://x/.well-known/oauth-protected-resource/mcp", { method: "GET" }))).json()) as { resource: string; authorization_servers: string[] }
    const cli = (await (await on(new Request("http://x/.well-known/oauth-protected-resource/cli", { method: "GET" }))).json()) as { resource: string; authorization_servers: string[] }
    expect(mcp.resource).toBe("https://blog.example.com/mcp")
    expect(cli.resource).toBe("https://blog.example.com/cli")
    expect(cli.authorization_servers).toEqual(mcp.authorization_servers)
    expect(cli.authorization_servers).toEqual(["https://blog.example.com"])
  })

  test("one bearer from the OAuth dance works on BOTH surfaces", async () => {
    const bearer = await connect("blog")
    expect((await rpc("/mcp", bearer, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200)
    expect((await rpc("/cli", bearer, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200)
  })

  // --- Tool surfaces ---

  test("/mcp exposes the editing tools (no get_started)", async () => {
    const bearer = await connect("blog")
    expect(await listTools("/mcp", bearer)).toEqual(
      ["delete_file", "deploy_site", "list_files", "read_file", "site_info", "write_file"]
    )
  })

  test("/cli exposes exactly one tool: get_started", async () => {
    const bearer = await connect("blog")
    expect(await listTools("/cli", bearer)).toEqual(["get_started"])
  })

  test("each surface rejects the other surface's tools", async () => {
    const bearer = await connect("blog")
    // get_started is not on /mcp
    expect((await call("/mcp", bearer, "get_started")).body.result!.isError).toBe(true)
    // editing tools are not on /cli
    for (const t of ["list_files", "write_file", "deploy_site", "site_info"]) {
      const { body } = await call("/cli", bearer, t)
      expect(body.result!.isError).toBe(true)
      expect(toolText(body)).toContain("Unknown tool")
    }
  })

  // --- /mcp editing behavior ---

  test("/mcp: write_file + deploy_site publishes web changes, preserves backend", async () => {
    const bearer = await connect("blog")
    await call("/mcp", bearer, "write_file", { path: "index.html", content: "<h1>edited</h1>" })
    const deploy = await call("/mcp", bearer, "deploy_site")
    expect(deploy.body.result!.isError).toBeFalsy()
    expect(toolText(deploy.body)).toContain("https://blog.example.com")

    const dl = await server.handleRequestForTest(new Request("http://x/sites/blog/download", { method: "GET", headers: AUTH }))
    const files = unzipSync(new Uint8Array(await dl.arrayBuffer()))
    const dec = (k: string) => new TextDecoder().decode(files[k]!)
    expect(dec("public/index.html")).toBe("<h1>edited</h1>")
    expect(dec("pb_migrations/1_init.js")).toBe("// schema")
  })

  test("/mcp initialize describes the file-editing workflow", async () => {
    const bearer = await connect("blog")
    const res = await rpc("/mcp", bearer, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    const body = (await res.json()) as { result: { instructions: string } }
    expect(body.result.instructions).toContain("write_file")
    expect(body.result.instructions).toContain("https://blog.example.com")
  })

  // --- /cli bridge behavior ---

  test("/cli: get_started returns a scoped CLI login that decodes to /_siteio + works", async () => {
    const bearer = await connect("blog")
    const { body } = await call("/cli", bearer, "get_started")
    const text = toolText(body)
    expect(text).toContain("siteio login -t ")
    expect(text).toContain("siteio sites download -n blog")
    expect(text).toContain("macOS and Linux only")
    expect(text).not.toContain("install.ps1")

    const loginToken = text.match(/siteio login -t (\S+)/)![1]!
    const { decodeToken } = await import("../../utils/token.ts")
    const decoded = decodeToken(loginToken)
    expect(decoded.url).toBe("https://blog.example.com/_siteio")
    const dl = await on(
      new Request("http://x/_siteio/sites/blog/download", { method: "GET", headers: { "X-API-Key": decoded.apiKey } })
    )
    expect(dl.status).toBe(200)
  })

  test("/cli initialize points the client at get_started", async () => {
    const bearer = await connect("blog")
    const res = await rpc("/cli", bearer, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    const body = (await res.json()) as { result: { instructions: string } }
    expect(body.result.instructions).toContain("get_started")
  })

  // --- Custom (vanity) domains ---

  describe("on a site's custom domain", () => {
    const CUSTOM = "beatrice.example.org"
    beforeEach(async () => {
      const res = await server.handleRequestForTest(
        new Request("http://x/sites/blog/domains", {
          method: "PATCH", headers: JSONH, body: JSON.stringify({ domains: [CUSTOM] }),
        })
      )
      expect(res.status).toBe(200)
    })

    test("discovery resolves the vanity host to its site and stays on that host", async () => {
      const res = await on(new Request("http://x/.well-known/oauth-protected-resource/mcp", { method: "GET" }), CUSTOM)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { resource: string; authorization_servers: string[] }
      expect(body.resource).toBe(`https://${CUSTOM}/mcp`)
      expect(body.authorization_servers).toEqual([`https://${CUSTOM}`])
    })

    test("the full OAuth dance + both surfaces work over the vanity host", async () => {
      const bearer = await connect("blog", {}, CUSTOM)
      expect((await rpc("/mcp", bearer, { jsonrpc: "2.0", id: 1, method: "tools/list" }, CUSTOM)).status).toBe(200)
      // get_started on the vanity host hands back a login token pointing at it.
      const gs = await call("/cli", bearer, "get_started", {}, CUSTOM)
      const text = gs.body.result!.content![0]!.text
      const loginToken = text.match(/siteio login -t (\S+)/)![1]!
      const { decodeToken } = await import("../../utils/token.ts")
      expect(decodeToken(loginToken).url).toBe(`https://${CUSTOM}/_siteio`)
    })

    test("an unknown host (not a site or custom domain) is 404", async () => {
      const res = await on(
        new Request("http://x/.well-known/oauth-protected-resource/mcp", { method: "GET" }),
        "nobody.example.net"
      )
      expect(res.status).toBe(404)
    })
  })

  // --- Revocation (shared) ---

  test("revoking the grant invalidates the bearer on both surfaces", async () => {
    const bearer = await connect("blog")
    expect((await rpc("/mcp", bearer, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200)
    // Owner/god endpoints live on the api host (default localhost), not the site host.
    const list = (await (
      await server.handleRequestForTest(new Request("http://x/sites/blog/grants", { method: "GET", headers: AUTH }))
    ).json()) as ApiResponse<{ id: string }[]>
    await server.handleRequestForTest(
      new Request(`http://x/sites/blog/grants/${list.data![0]!.id}`, { method: "DELETE", headers: AUTH })
    )
    expect((await rpc("/mcp", bearer, { jsonrpc: "2.0", id: 2, method: "ping" })).status).toBe(401)
    expect((await rpc("/cli", bearer, { jsonrpc: "2.0", id: 2, method: "ping" })).status).toBe(401)
  })
})
