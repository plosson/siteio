import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync, unzipSync } from "fflate"
import { randomBytes, createHash } from "crypto"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, ApiResponse, ShareGrantCreated, SiteVersion } from "../../types.ts"

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

describe("API: MCP share endpoint (OAuth bearer, per-site)", () => {
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

  // Run the full OAuth share-code dance and return a bearer access token.
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
    await deploySite("blog", {
      "public/index.html": "<h1>original</h1>",
      "pb_migrations/1_init.js": "// schema",
    })
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

  test("initialize returns protocol + server info", async () => {
    const token = await connect("blog")
    const res = await mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result?: { protocolVersion?: string; serverInfo?: { name: string } } }
    expect(body.result!.protocolVersion).toBeTruthy()
    expect(body.result!.serverInfo!.name).toBe("siteio-site-editor")
  })

  test("initialize reports the default <name>.<domain> URL when no custom domain is set", async () => {
    const token = await connect("blog")
    const res = await mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    const body = (await res.json()) as { result: { instructions: string } }
    expect(body.result.instructions).toContain("https://blog.example.com")
  })

  test("initialize reports ONLY the custom domain once set (default subdomain suppressed)", async () => {
    await server.handleRequestForTest(
      new Request("http://x/sites/blog/domains", {
        method: "PATCH", headers: JSONH, body: JSON.stringify({ domains: ["www.myblog.org", "myblog.org"] }),
      })
    )
    const token = await connect("blog")
    const res = await mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    const body = (await res.json()) as { result: { instructions: string } }
    expect(body.result.instructions).toContain("https://www.myblog.org")
    expect(body.result.instructions).not.toContain("blog.example.com")
  })

  test("tools/list advertises the file tools plus site_info", async () => {
    const token = await connect("blog")
    const res = await mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    const body = (await res.json()) as { result: { tools: { name: string }[] } }
    expect(body.result.tools.map((t) => t.name).sort()).toEqual(
      ["delete_file", "deploy_site", "list_files", "read_file", "site_info", "write_file"]
    )
  })

  test("site_info reports the default subdomain when no custom domain is set", async () => {
    const token = await connect("blog")
    const { body } = await call(token, "site_info")
    expect(toolText(body)).toContain("https://blog.example.com")
    expect(toolText(body)).toContain("Current published version: 1")
  })

  test("list_files seeds the web root only (no backend, no public/ prefix)", async () => {
    const token = await connect("blog")
    const { body } = await call(token, "list_files")
    expect(toolText(body)).toBe("index.html")
  })

  test("read_file keeps the raw file in content[0]; context rides in content[1]", async () => {
    const token = await connect("blog")
    const res = await mcp(token, {
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "index.html" } },
    })
    const body = (await res.json()) as { result: { content: { text: string }[] } }
    expect(body.result.content[0]!.text).toBe("<h1>original</h1>")
    expect(body.result.content[1]!.text).toContain("editing site \"blog\"")
  })

  test("write_file + deploy_site publishes web changes and preserves the backend", async () => {
    const token = await connect("blog", { maxDeploys: 1 })
    await call(token, "write_file", { path: "index.html", content: "<h1>edited by invitee</h1>" })
    await call(token, "write_file", { path: "about.html", content: "<h1>about</h1>" })
    const deploy = await call(token, "deploy_site")
    expect(deploy.body.result!.isError).toBeFalsy()
    expect(toolText(deploy.body)).toContain("https://blog.example.com")

    const dl = await server.handleRequestForTest(
      new Request("http://x/sites/blog/download", { method: "GET", headers: AUTH })
    )
    const files = unzipSync(new Uint8Array(await dl.arrayBuffer()))
    const dec = (k: string) => new TextDecoder().decode(files[k]!)
    expect(dec("public/index.html")).toBe("<h1>edited by invitee</h1>")
    expect(dec("public/about.html")).toBe("<h1>about</h1>")
    expect(dec("pb_migrations/1_init.js")).toBe("// schema")
  })

  test("the deploy budget is consumed — an exhausted grant kills the bearer token", async () => {
    const token = await connect("blog", { maxDeploys: 1 })
    await call(token, "deploy_site")
    // Grant exhausted → token no longer maps to a live grant.
    const res = await mcp(token, { jsonrpc: "2.0", id: 9, method: "tools/list" })
    expect(res.status).toBe(401)
  })

  test("multiple deploys allowed up to the budget", async () => {
    const token = await connect("blog", { maxDeploys: 2 })
    expect(toolText((await call(token, "deploy_site")).body)).toContain("1 deploy(s) remaining")
    expect(toolText((await call(token, "deploy_site")).body)).toContain("0 deploy(s) remaining")
    expect((await mcp(token, { jsonrpc: "2.0", id: 3, method: "ping" })).status).toBe(401)
  })

  test("deploys are attributed to the grant label in history", async () => {
    const token = await connect("blog", { maxDeploys: 2, label: "Sam" })
    await call(token, "write_file", { path: "index.html", content: "v-sam-1" })
    await call(token, "deploy_site")
    await call(token, "deploy_site")
    const res = await server.handleRequestForTest(
      new Request("http://x/sites/blog/history", { method: "GET", headers: AUTH })
    )
    const body = (await res.json()) as ApiResponse<SiteVersion[]>
    expect(body.data!.some((v) => v.deployedBy === "Sam")).toBe(true)
  })

  test("a mid-session external deploy is auto-rebased with a note", async () => {
    const token = await connect("blog", { maxDeploys: 2 })
    await call(token, "list_files")
    await call(token, "write_file", { path: "index.html", content: "<h1>invitee change</h1>" })
    await deploySite("blog", { "public/index.html": "<h1>owner change</h1>", "pb_migrations/1_init.js": "// schema" })
    const deploy = await call(token, "deploy_site")
    expect(deploy.body.result!.isError).toBeFalsy()
    expect(toolText(deploy.body)).toContain("had changed since you started editing")
  })

  test("revoking the grant immediately invalidates a live bearer token", async () => {
    const token = await connect("blog", { maxDeploys: 5 })
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

  test("path traversal in write_file is rejected as a tool error", async () => {
    const token = await connect("blog")
    const { body } = await call(token, "write_file", { path: "../../etc/pwned", content: "x" })
    expect(body.result!.isError).toBe(true)
    expect(toolText(body)).toContain("Unsafe path")
  })

  test("notifications get a 202 with no body", async () => {
    const token = await connect("blog")
    const res = await mcp(token, { jsonrpc: "2.0", method: "notifications/initialized" })
    expect(res.status).toBe(202)
  })

  test("every tool response carries a site-context block with the live URL", async () => {
    const token = await connect("blog", { maxDeploys: 3 })
    const res = await mcp(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_files", arguments: {} } })
    const body = (await res.json()) as { result: { content: { type: string; text: string }[] } }
    expect(body.result.content).toHaveLength(2)
    expect(body.result.content[1]!.text).toContain("https://blog.example.com")
    expect(body.result.content[1]!.text).toContain("deploy(s) left")
  })
})
