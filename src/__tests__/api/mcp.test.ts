import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync, unzipSync } from "fflate"
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

// Extract the text of a tools/call result.
function toolText(body: { result?: { content?: { text: string }[]; isError?: boolean } }): string {
  return body.result?.content?.[0]?.text ?? ""
}

describe("API: MCP share endpoint", () => {
  let dataDir: string
  let runtime: FakeRuntime
  let server: AgentServer

  const deploySite = (name: string, files: Record<string, string>) =>
    server.handleRequestForTest(
      new Request(`http://x/sites/${name}`, {
        method: "POST", headers: ZIPH,
        body: zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)]))),
      })
    )

  const mintGrant = async (name: string, body: Record<string, unknown> = {}): Promise<string> => {
    const res = await server.handleRequestForTest(
      new Request(`http://x/sites/${name}/grants`, { method: "POST", headers: JSONH, body: JSON.stringify(body) })
    )
    const parsed = (await res.json()) as ApiResponse<ShareGrantCreated>
    return parsed.data!.token
  }

  const mcp = (token: string, message: unknown) =>
    server.handleRequestForTest(
      new Request(`http://x/mcp/${token}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(message),
      })
    )

  const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const res = await mcp(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
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

  test("initialize returns protocol + server info", async () => {
    const token = await mintGrant("blog")
    const res = await mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result?: { protocolVersion?: string; serverInfo?: { name: string } } }
    expect(body.result!.protocolVersion).toBeTruthy()
    expect(body.result!.serverInfo!.name).toBe("siteio-site-editor")
  })

  test("initialize reports the default <name>.<domain> URL when no custom domain is set", async () => {
    const token = await mintGrant("blog")
    const res = await mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    const body = (await res.json()) as { result: { instructions: string } }
    expect(body.result.instructions).toContain("https://blog.example.com")
  })

  test("initialize reports ONLY the custom domain once one is set (default subdomain suppressed)", async () => {
    await server.handleRequestForTest(
      new Request("http://x/sites/blog/domains", {
        method: "PATCH", headers: JSONH, body: JSON.stringify({ domains: ["www.myblog.org", "myblog.org"] }),
      })
    )
    const token = await mintGrant("blog")
    const res = await mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    const body = (await res.json()) as { result: { instructions: string } }
    expect(body.result.instructions).toContain("https://www.myblog.org")
    expect(body.result.instructions).toContain("https://myblog.org")
    // The default subdomain must NOT be advertised once a custom domain exists.
    expect(body.result.instructions).not.toContain("blog.example.com")
  })

  test("tools/list advertises the file tools plus site_info", async () => {
    const token = await mintGrant("blog")
    const res = await mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    const body = (await res.json()) as { result: { tools: { name: string }[] } }
    expect(body.result.tools.map((t) => t.name).sort()).toEqual(
      ["delete_file", "deploy_site", "list_files", "read_file", "site_info", "write_file"]
    )
  })

  test("site_info reports the default subdomain when no custom domain is set", async () => {
    const token = await mintGrant("blog")
    const { body } = await call(token, "site_info")
    expect(toolText(body)).toContain("https://blog.example.com")
    expect(toolText(body)).toContain("Current published version: 1")
  })

  test("site_info reports ONLY the custom domain once one is set", async () => {
    await server.handleRequestForTest(
      new Request("http://x/sites/blog/domains", {
        method: "PATCH", headers: JSONH, body: JSON.stringify({ domains: ["shop.example.org"] }),
      })
    )
    const token = await mintGrant("blog")
    const { body } = await call(token, "site_info")
    expect(toolText(body)).toContain("https://shop.example.org")
    expect(toolText(body)).not.toContain("blog.example.com")
  })

  test("every tool response carries a site-context block with the live URL", async () => {
    const token = await mintGrant("blog", { maxDeploys: 3 })
    const res = await mcp(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_files", arguments: {} } })
    const body = (await res.json()) as { result: { content: { type: string; text: string }[] } }
    // content[0] is the tool's primary output; content[1] is the context block.
    expect(body.result.content).toHaveLength(2)
    expect(body.result.content[1]!.text).toContain("https://blog.example.com")
    expect(body.result.content[1]!.text).toContain("deploy(s) left")
  })

  test("read_file keeps the raw file in content[0] — context is a separate block", async () => {
    const token = await mintGrant("blog")
    const res = await mcp(token, {
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "index.html" } },
    })
    const body = (await res.json()) as { result: { content: { text: string }[] } }
    expect(body.result.content[0]!.text).toBe("<h1>original</h1>") // not polluted
    expect(body.result.content[1]!.text).toContain("editing site \"blog\"")
  })

  test("list_files seeds the web root only (no backend, no public/ prefix)", async () => {
    const token = await mintGrant("blog")
    const { body } = await call(token, "list_files")
    expect(toolText(body)).toBe("index.html")
  })

  test("read_file returns the current web file content", async () => {
    const token = await mintGrant("blog")
    const { body } = await call(token, "read_file", { path: "index.html" })
    expect(toolText(body)).toBe("<h1>original</h1>")
  })

  test("write_file + deploy_site publishes web changes and preserves the backend", async () => {
    const token = await mintGrant("blog", { maxDeploys: 1 })

    await call(token, "write_file", { path: "index.html", content: "<h1>edited by invitee</h1>" })
    await call(token, "write_file", { path: "about.html", content: "<h1>about</h1>" })
    const deploy = await call(token, "deploy_site")
    expect(deploy.body.result!.isError).toBeFalsy()
    expect(toolText(deploy.body)).toContain("https://blog.example.com")

    // The live code now has the invitee's web edits AND the untouched backend.
    const dl = await server.handleRequestForTest(
      new Request("http://x/sites/blog/download", { method: "GET", headers: AUTH })
    )
    const files = unzipSync(new Uint8Array(await dl.arrayBuffer()))
    const dec = (k: string) => new TextDecoder().decode(files[k]!)
    expect(dec("public/index.html")).toBe("<h1>edited by invitee</h1>")
    expect(dec("public/about.html")).toBe("<h1>about</h1>")
    expect(dec("pb_migrations/1_init.js")).toBe("// schema")
  })

  test("the deploy budget is consumed — an exhausted link is rejected", async () => {
    const token = await mintGrant("blog", { maxDeploys: 1 })
    await call(token, "deploy_site")

    // Grant is now used up: any further MCP call is unauthorized.
    const res = await mcp(token, { jsonrpc: "2.0", id: 9, method: "tools/list" })
    expect(res.status).toBe(401)
  })

  test("multiple deploys allowed up to the budget", async () => {
    const token = await mintGrant("blog", { maxDeploys: 2 })
    const first = await call(token, "deploy_site")
    expect(toolText(first.body)).toContain("1 deploy(s) remaining")
    const second = await call(token, "deploy_site")
    expect(toolText(second.body)).toContain("0 deploy(s) remaining")
    // Budget now exhausted.
    const third = await mcp(token, { jsonrpc: "2.0", id: 3, method: "ping" })
    expect(third.status).toBe(401)
  })

  test("deploys are attributed to the grant label in history", async () => {
    const token = await mintGrant("blog", { maxDeploys: 2, label: "Sam" })
    await call(token, "write_file", { path: "index.html", content: "v-sam-1" })
    await call(token, "deploy_site") // -> becomes current version, deployedBy "Sam"
    await call(token, "deploy_site") // -> archives the previous (Sam) version into history

    const res = await server.handleRequestForTest(
      new Request("http://x/sites/blog/history", { method: "GET", headers: AUTH })
    )
    const body = (await res.json()) as ApiResponse<SiteVersion[]>
    expect(body.data!.some((v) => v.deployedBy === "Sam")).toBe(true)
  })

  test("a mid-session external deploy is auto-rebased with a note", async () => {
    const token = await mintGrant("blog", { maxDeploys: 2 })
    // Seed the staging copy at the current version.
    await call(token, "list_files")
    await call(token, "write_file", { path: "index.html", content: "<h1>invitee change</h1>" })
    // Owner deploys out-of-band, bumping the site version underneath the invitee.
    await deploySite("blog", { "public/index.html": "<h1>owner change</h1>", "pb_migrations/1_init.js": "// schema" })

    const deploy = await call(token, "deploy_site")
    expect(deploy.body.result!.isError).toBeFalsy()
    expect(toolText(deploy.body)).toContain("had changed since you started editing")
  })

  test("invalid, malformed, and unknown tokens are all unauthorized", async () => {
    const wellFormedButUnknown = "grt_" + "a".repeat(40)
    expect((await mcp(wellFormedButUnknown, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401)
    expect((await mcp("not-a-grant-token", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401)

    // A revoked token is rejected too.
    const token = await mintGrant("blog")
    const list = (await (
      await server.handleRequestForTest(new Request("http://x/sites/blog/grants", { method: "GET", headers: AUTH }))
    ).json()) as ApiResponse<{ id: string }[]>
    await server.handleRequestForTest(
      new Request(`http://x/sites/blog/grants/${list.data![0]!.id}`, { method: "DELETE", headers: AUTH })
    )
    expect((await mcp(token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401)
  })

  test("path traversal in write_file is rejected as a tool error", async () => {
    const token = await mintGrant("blog")
    const { body } = await call(token, "write_file", { path: "../../etc/pwned", content: "x" })
    expect(body.result!.isError).toBe(true)
    expect(toolText(body)).toContain("Unsafe path")
  })

  test("notifications get a 202 with no body", async () => {
    const token = await mintGrant("blog")
    const res = await mcp(token, { jsonrpc: "2.0", method: "notifications/initialized" })
    expect(res.status).toBe(202)
  })

  test("the MCP endpoint bypasses the god API key (token-only auth)", async () => {
    const token = await mintGrant("blog")
    // No X-API-Key header at all, yet tools/list works via the grant token.
    const res = await server.handleRequestForTest(
      new Request(`http://x/mcp/${token}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    )
    expect(res.status).toBe(200)
  })
})
