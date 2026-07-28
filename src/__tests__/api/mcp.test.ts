import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync, unzipSync } from "fflate"
import { randomBytes, createHash } from "crypto"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, ApiResponse, ShareGrantCreated } from "../../types.ts"

function makeServer(
  dataDir: string,
  runtime: FakeRuntime,
  hooks?: { fetchAsset?: (url: string) => Promise<Uint8Array> }
): AgentServer {
  const config: AgentConfig = {
    apiKey: "test-key", dataDir, domain: "example.com",
    maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
  }
  return new AgentServer(config, runtime, hooks)
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

describe("API: MCP surface — /mcp (editing) over per-site OAuth", () => {
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

  // Run the OAuth share-code dance once (on `host`) → a bearer for /mcp.
  // Grants are minted on the api host; the dance runs on the site host.
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

  const rpc = (endpoint: "/mcp", bearer: string, message: unknown, host = HOST) =>
    on(
      new Request(`http://x${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
        body: JSON.stringify(message),
      }),
      host
    )
  const call = async (endpoint: "/mcp", bearer: string, name: string, args: Record<string, unknown> = {}, host = HOST) => {
    const res = await rpc(endpoint, bearer, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, host)
    return { status: res.status, body: (await res.json()) as { result?: { content?: { text: string }[]; isError?: boolean } } }
  }
  const listTools = async (endpoint: "/mcp", bearer: string) => {
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

  // --- Auth ---

  test("unauthenticated /mcp 401s to its protected-resource metadata", async () => {
    const mcp = await on(new Request("http://x/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))
    expect(mcp.status).toBe(401)
    expect(mcp.headers.get("WWW-Authenticate")).toContain("/.well-known/oauth-protected-resource/mcp")
  })

  test("protected-resource metadata (bare path and /mcp) names the site's auth server", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const meta = (await (await on(new Request(`http://x${path}`, { method: "GET" }))).json()) as { resource: string; authorization_servers: string[] }
      expect(meta.resource).toBe("https://blog.example.com/mcp")
      expect(meta.authorization_servers).toEqual(["https://blog.example.com"])
    }
  })

  test("a bearer from the OAuth dance authenticates /mcp", async () => {
    const bearer = await connect("blog")
    expect((await rpc("/mcp", bearer, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200)
  })

  // --- Tool surface ---

  test("/mcp exposes the editing tools", async () => {
    const bearer = await connect("blog")
    expect(await listTools("/mcp", bearer)).toEqual(
      ["delete_file", "deploy_site", "edit_file", "list_files", "list_history", "read_file", "site_info", "write_file", "write_url"]
    )
  })

  test("/mcp rejects an unknown tool", async () => {
    const bearer = await connect("blog")
    const { body } = await call("/mcp", bearer, "get_started")
    expect(body.result!.isError).toBe(true)
    expect(toolText(body)).toContain("Unknown tool")
  })

  // --- /mcp editing behavior ---

  test("/mcp: write_file + deploy_site publishes web changes, preserves backend", async () => {
    const bearer = await connect("blog")
    await call("/mcp", bearer, "write_file", { path: "index.html", content: "<h1>edited</h1>" })
    const deploy = await call("/mcp", bearer, "deploy_site", { message: "Edit the heading" })
    expect(deploy.body.result!.isError).toBeFalsy()
    expect(toolText(deploy.body)).toContain("https://blog.example.com")

    const dl = await server.handleRequestForTest(new Request("http://x/sites/blog/download", { method: "GET", headers: AUTH }))
    const files = unzipSync(new Uint8Array(await dl.arrayBuffer()))
    const dec = (k: string) => new TextDecoder().decode(files[k]!)
    expect(dec("public/index.html")).toBe("<h1>edited</h1>")
    expect(dec("pb_migrations/1_init.js")).toBe("// schema")
  })

  test("/mcp: edit_file replaces an exact snippet, staged then published", async () => {
    const bearer = await connect("blog")
    const res = await call("/mcp", bearer, "edit_file", {
      path: "index.html",
      old_string: "<h1>original</h1>",
      new_string: "<h1>edited via edit_file</h1>",
    })
    expect(res.body.result!.isError).toBeFalsy()
    expect(toolText(res.body)).toContain("1 replacement")
    await call("/mcp", bearer, "deploy_site", { message: "Swap heading via edit_file" })

    const dl = await server.handleRequestForTest(new Request("http://x/sites/blog/download", { method: "GET", headers: AUTH }))
    const files = unzipSync(new Uint8Array(await dl.arrayBuffer()))
    expect(new TextDecoder().decode(files["public/index.html"]!)).toBe("<h1>edited via edit_file</h1>")
  })

  test("/mcp: deploy_site requires a change message and records it in history", async () => {
    const bearer = await connect("blog")
    await call("/mcp", bearer, "write_file", { path: "index.html", content: "<h1>v2</h1>" })
    // Missing message → rejected, nothing published.
    const missing = await call("/mcp", bearer, "deploy_site")
    expect(missing.body.result!.isError).toBe(true)
    expect(toolText(missing.body)).toContain("message is required")
    // Blank/whitespace is also rejected.
    const blank = await call("/mcp", bearer, "deploy_site", { message: "   " })
    expect(blank.body.result!.isError).toBe(true)
    // With a message → published, and the message shows up in list_history.
    const ok = await call("/mcp", bearer, "deploy_site", { message: "Rewrite the homepage heading" })
    expect(ok.body.result!.isError).toBeFalsy()
    const history = await call("/mcp", bearer, "list_history")
    expect(toolText(history.body)).toContain("Rewrite the homepage heading")
  })

  test("/mcp: edit_file errors when old_string is missing or ambiguous", async () => {
    const bearer = await connect("blog")
    await call("/mcp", bearer, "write_file", { path: "dup.html", content: "x\nx\n" })
    const missing = await call("/mcp", bearer, "edit_file", { path: "dup.html", old_string: "nope", new_string: "y" })
    expect(missing.body.result!.isError).toBe(true)
    expect(toolText(missing.body)).toContain("not found")
    const ambiguous = await call("/mcp", bearer, "edit_file", { path: "dup.html", old_string: "x", new_string: "y" })
    expect(ambiguous.body.result!.isError).toBe(true)
    expect(toolText(ambiguous.body)).toContain("occurs 2 times")
    // replace_all resolves the ambiguity.
    const all = await call("/mcp", bearer, "edit_file", { path: "dup.html", old_string: "x", new_string: "y", replace_all: true })
    expect(all.body.result!.isError).toBeFalsy()
    expect(toolText(all.body)).toContain("2 replacements")
  })

  test("/mcp exposes guidance resources; resources/read returns markdown", async () => {
    const bearer = await connect("blog")
    const listRes = await rpc("/mcp", bearer, { jsonrpc: "2.0", id: 1, method: "resources/list" })
    const list = (await listRes.json()) as { result: { resources: { uri: string; text?: string }[] } }
    const uris = list.result.resources.map((r) => r.uri).sort()
    expect(uris).toEqual(["siteio://guide/conventions", "siteio://guide/editing"])
    // list must NOT leak the body.
    expect(list.result.resources.every((r) => r.text === undefined)).toBe(true)

    const readRes = await rpc("/mcp", bearer, {
      jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "siteio://guide/editing" },
    })
    const read = (await readRes.json()) as { result: { contents: { uri: string; mimeType: string; text: string }[] } }
    expect(read.result.contents[0]!.mimeType).toBe("text/markdown")
    expect(read.result.contents[0]!.text).toContain("deploy_site")

    const missing = (await (await rpc("/mcp", bearer, {
      jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "siteio://nope" },
    })).json()) as { error?: { code: number } }
    expect(missing.error!.code).toBe(-32602)
  })

  test("/mcp: list_history returns the deployment changelog, newest first, with attribution", async () => {
    // Owner deploys, then two share deploys labelled "Sam".
    await deploySite("blog", { "public/index.html": "v-owner" })
    const bearer = await connect("blog", { label: "Sam" })
    await call("/mcp", bearer, "write_file", { path: "index.html", content: "v-sam-1" })
    await call("/mcp", bearer, "deploy_site", { message: "First Sam edit" })
    await call("/mcp", bearer, "write_file", { path: "index.html", content: "v-sam-2" })
    await call("/mcp", bearer, "deploy_site", { message: "Second Sam edit" })

    const { body } = await call("/mcp", bearer, "list_history")
    const text = toolText(body)
    expect(text).toContain("Deployment history")
    expect(text).toContain("(current)")
    expect(text).toContain("by Sam")
    // Each share deploy's message is attributed to its version.
    expect(text).toContain("Second Sam edit")
    expect(text).toContain("First Sam edit")
    // Newest-first: the current line comes before older version lines.
    const versions = [...text.matchAll(/v(\d+)/g)].map((m) => Number(m[1]))
    expect(versions[0]).toBeGreaterThan(versions[versions.length - 1]!)
  })

  test("/mcp initialize describes the file-editing workflow", async () => {
    const bearer = await connect("blog")
    const res = await rpc("/mcp", bearer, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    const body = (await res.json()) as { result: { instructions: string } }
    expect(body.result.instructions).toContain("write_file")
    expect(body.result.instructions).toContain("https://blog.example.com")
  })

  // --- write_url (server-side asset fetch, /mcp only) ---

  describe("write_url", () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    // Rebuild the shared server with a stubbed asset fetcher for the happy path.
    beforeEach(async () => {
      server = makeServer(dataDir, runtime, {
        fetchAsset: async (url: string) => {
          if (url.includes("bad")) throw new Error("stub should not be called for blocked URLs")
          return PNG
        },
      })
      await deploySite("blog", { "public/index.html": "<h1>original</h1>", "pb_migrations/1_init.js": "// schema" })
    })

    test("fetches a URL server-side and stages it, published on deploy", async () => {
      const bearer = await connect("blog")
      const res = await call("/mcp", bearer, "write_url", { path: "img/logo.png", url: "https://cdn.example.com/logo.png" })
      expect(res.body.result!.isError).toBeFalsy()
      expect(toolText(res.body)).toContain("img/logo.png")

      await call("/mcp", bearer, "deploy_site", { message: "Add logo image" })
      const dl = await server.handleRequestForTest(new Request("http://x/sites/blog/download", { method: "GET", headers: AUTH }))
      const files = unzipSync(new Uint8Array(await dl.arrayBuffer()))
      expect(files["public/img/logo.png"]).toEqual(PNG)
    })

    test("path traversal is rejected", async () => {
      const bearer = await connect("blog")
      const res = await call("/mcp", bearer, "write_url", { path: "../../evil", url: "https://cdn.example.com/x.png" })
      expect(res.body.result!.isError).toBe(true)
      expect(toolText(res.body)).toMatch(/unsafe path/i)
    })

  })

  describe("write_url SSRF guard (real fetcher)", () => {
    // No stub — exercises the server's real SSRF-guarded fetch.
    test("refuses internal/private and non-http targets before fetching", async () => {
      const bearer = await connect("blog")
      for (const url of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:8080/api", "file:///etc/passwd"]) {
        const res = await call("/mcp", bearer, "write_url", { path: "x", url })
        expect(res.body.result!.isError).toBe(true)
      }
    })
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

    test("the full OAuth dance + /mcp editing work over the vanity host", async () => {
      const bearer = await connect("blog", {}, CUSTOM)
      expect((await rpc("/mcp", bearer, { jsonrpc: "2.0", id: 1, method: "tools/list" }, CUSTOM)).status).toBe(200)
      // site_info on the vanity host reports the custom domain as the live URL.
      const info = await call("/mcp", bearer, "site_info", {}, CUSTOM)
      expect(toolText(info.body)).toContain(`https://${CUSTOM}`)
    })

    test("an unknown host (not a site or custom domain) is 404", async () => {
      const res = await on(
        new Request("http://x/.well-known/oauth-protected-resource/mcp", { method: "GET" }),
        "nobody.example.net"
      )
      expect(res.status).toBe(404)
    })
  })

  // --- Revocation ---

  test("revoking the grant invalidates the bearer", async () => {
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
  })
})
