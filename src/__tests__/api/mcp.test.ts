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

function toolText(body: { result?: { content?: { text: string }[]; isError?: boolean } }): string {
  return body.result?.content?.[0]?.text ?? ""
}

describe("API: MCP share endpoint (single get_started tool, OAuth bearer)", () => {
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

  // Full OAuth share-code dance → bearer access token.
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

  const mcp = (bearer: string, message: unknown, host = HOST) =>
    on(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
        body: JSON.stringify(message),
      }),
      host
    )

  const call = async (bearer: string, name: string, args: Record<string, unknown> = {}) => {
    const res = await mcp(bearer, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
    return { status: res.status, body: (await res.json()) as { result?: { content?: { text: string }[]; isError?: boolean } } }
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-mcp-"))
    runtime = new FakeRuntime()
    server = makeServer(dataDir, runtime)
    await deploySite("blog", { "public/index.html": "<h1>original</h1>", "pb_migrations/1_init.js": "// schema" })
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  test("an MCP call with no bearer returns 401 + a WWW-Authenticate challenge", async () => {
    const res = await on(
      new Request("http://x/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    )
    expect(res.status).toBe(401)
    expect(res.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://blog.example.com/.well-known/oauth-protected-resource"'
    )
  })

  test("initialize points the client at get_started + reports the live URL", async () => {
    const token = await connect("blog")
    const res = await mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result?: { serverInfo?: { name: string }; instructions?: string } }
    expect(body.result!.serverInfo!.name).toBe("siteio-site-editor")
    expect(body.result!.instructions).toContain("get_started")
    expect(body.result!.instructions).toContain("https://blog.example.com")
  })

  test("tools/list advertises exactly one tool: get_started", async () => {
    const token = await connect("blog")
    const res = await mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    const body = (await res.json()) as { result: { tools: { name: string }[] } }
    expect(body.result.tools.map((t) => t.name)).toEqual(["get_started"])
  })

  test("get_started returns a scoped siteio CLI login that decodes to /_siteio + a working key", async () => {
    const token = await connect("blog")
    const { body } = await call(token, "get_started")
    const text = toolText(body)
    expect(text).toContain("siteio login -t ")
    expect(text).toContain("siteio sites download -n blog")
    // Unix-only installer; no Windows/PowerShell command.
    expect(text).toContain("curl -LsSf https://siteio.houlahop.com/install | sh")
    expect(text).toContain("macOS and Linux only")
    expect(text).not.toContain("install.ps1")

    // The embedded login token points at the scoped site-host channel …
    const loginToken = text.match(/siteio login -t (\S+)/)![1]!
    const { decodeToken } = await import("../../utils/token.ts")
    const decoded = decodeToken(loginToken)
    expect(decoded.url).toBe("https://blog.example.com/_siteio")
    // … and the embedded key (the session bearer) actually authorizes a scoped download.
    const dl = await on(
      new Request("http://x/_siteio/sites/blog/download", { method: "GET", headers: { "X-API-Key": decoded.apiKey } }),
      HOST
    )
    expect(dl.status).toBe(200)
  })

  test("get_started mentions backend access only when the grant allows it", async () => {
    const webOnly = await connect("blog")
    expect(toolText((await call(webOnly, "get_started")).body)).toContain("web files")
    const backend = await connect("blog", { allowBackend: true })
    expect(toolText((await call(backend, "get_started")).body)).toContain("web files and backend")
  })

  test("get_started response carries the site-context block", async () => {
    const token = await connect("blog")
    const res = await mcp(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_started", arguments: {} } })
    const body = (await res.json()) as { result: { content: { type: string; text: string }[] } }
    expect(body.result.content).toHaveLength(2)
    expect(body.result.content[1]!.text).toContain(`editing site "blog"`)
    expect(body.result.content[1]!.text).toContain("https://blog.example.com")
  })

  test("the removed file/deploy tools are gone", async () => {
    const token = await connect("blog")
    for (const name of ["list_files", "read_file", "write_file", "delete_file", "deploy_site", "site_info"]) {
      const { body } = await call(token, name)
      expect(body.result!.isError).toBe(true)
      expect(toolText(body)).toContain("Unknown tool")
    }
  })

  test("revoking the grant immediately invalidates a live bearer token", async () => {
    const token = await connect("blog")
    expect((await mcp(token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200)
    const list = (await (
      await server.handleRequestForTest(new Request("http://x/sites/blog/grants", { method: "GET", headers: AUTH }))
    ).json()) as ApiResponse<{ id: string }[]>
    await server.handleRequestForTest(
      new Request(`http://x/sites/blog/grants/${list.data![0]!.id}`, { method: "DELETE", headers: AUTH })
    )
    expect((await mcp(token, { jsonrpc: "2.0", id: 2, method: "ping" })).status).toBe(401)
  })

  test("a garbage or empty bearer is unauthorized", async () => {
    expect((await mcp("at_not-a-real-token", { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401)
    expect((await mcp("", { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401)
  })

  test("notifications get a 202 with no body", async () => {
    const token = await connect("blog")
    const res = await mcp(token, { jsonrpc: "2.0", method: "notifications/initialized" })
    expect(res.status).toBe(202)
  })
})
