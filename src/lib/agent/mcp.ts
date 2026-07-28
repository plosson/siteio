import type { ShareGrant } from "../../types.ts"
import type { GrantStore } from "./grant-store.ts"
import type { SiteStorage } from "./storage.ts"
import type { OAuthStore } from "./oauth-store.ts"
import { getVersion } from "../version.ts"
import { encodeToken } from "../../utils/token.ts"

const MCP_PROTOCOL_VERSION = "2024-11-05"

// JSON-RPC 2.0 shapes (only the slice MCP needs).
interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

// Site context resolved from the request Host by the server (never api.<domain>).
export interface McpHostCtx {
  baseUrl: string // https://<site>.<domain>
  site: string
}

export interface McpDeps {
  grants: GrantStore
  sites: SiteStorage
  oauth: OAuthStore
  domain: string // base domain, for building the site's public URL(s)
}

// A deliberately minimal Model Context Protocol server, served per-site at
// `https://<site>.<domain>/mcp` and authenticated by an OAuth bearer token
// (obtained via the share-code flow — see OAuthProvider). It exposes exactly
// ONE tool — `get_started` — which hands the connected AI a scoped `siteio`
// CLI login plus instructions. All real editing happens through the CLI, not
// through MCP tools: the MCP is purely a bootstrap/hand-off surface. (This
// mirrors the "MCP-as-CLI-bridge" pattern — expose a thin delegation tool
// rather than reimplementing every file/deploy operation as a granular tool.)
export class McpHandler {
  constructor(private deps: McpDeps) {}

  private jsonRpcError(id: JsonRpcRequest["id"], code: number, message: string): Response {
    return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } })
  }

  // Entry point. `ctx` is the site resolved from the request Host by the server.
  async handle(req: Request, ctx: McpHostCtx): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } })
    }

    // Bearer auth: the client obtained this token via the OAuth share-code flow.
    const auth = req.headers.get("authorization") || ""
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : ""
    const record = bearer ? this.deps.oauth.resolveAccessToken(bearer) : null
    const grant = record ? this.deps.grants.get(record.grantId) : null
    if (!grant || !this.deps.grants.isActive(grant) || grant.site !== ctx.site) {
      return this.challenge(ctx)
    }

    let payload: unknown
    try {
      payload = await req.json()
    } catch {
      return this.jsonRpcError(null, -32700, "Parse error")
    }

    if (Array.isArray(payload)) {
      const responses: unknown[] = []
      for (const msg of payload) {
        const res = await this.dispatch(msg as JsonRpcRequest, grant, ctx, bearer)
        if (res !== null) responses.push(res)
      }
      if (responses.length === 0) return new Response(null, { status: 202 })
      return Response.json(responses)
    }

    const single = await this.dispatch(payload as JsonRpcRequest, grant, ctx, bearer)
    if (single === null) return new Response(null, { status: 202 })
    return Response.json(single)
  }

  // 401 that points the client at this site's protected-resource metadata, so
  // it can discover the OAuth authorization server and start the flow.
  private challenge(ctx: McpHostCtx): Response {
    return new Response(JSON.stringify({ error: "unauthorized", error_description: "Authorization required" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${ctx.baseUrl}/.well-known/oauth-protected-resource"`,
      },
    })
  }

  private async dispatch(
    msg: JsonRpcRequest,
    grant: ShareGrant,
    ctx: McpHostCtx,
    bearer: string
  ): Promise<unknown | null> {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return { jsonrpc: "2.0", id: (msg && msg.id) ?? null, error: { code: -32600, message: "Invalid Request" } }
    }

    const isNotification = msg.id === undefined || msg.id === null
    if (msg.method.startsWith("notifications/")) return null

    switch (msg.method) {
      case "initialize": {
        const urls = this.liveUrls(grant)
        const liveAt = urls.length ? ` It is live at ${urls.join(", ")}.` : ""
        return this.ok(msg.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "siteio-site-editor", version: getVersion() },
          instructions:
            `You can edit and publish the website "${grant.site}".${liveAt} ` +
            `Call the get_started tool first — it returns a scoped siteio CLI login and the exact ` +
            `commands to download the site, edit it locally (including images and other assets), and deploy.`,
        })
      }
      case "ping":
        return this.ok(msg.id, {})
      case "tools/list":
        return this.ok(msg.id, { tools: TOOL_DEFINITIONS })
      case "tools/call":
        return this.handleToolCall(msg, grant, ctx, bearer)
      default:
        if (isNotification) return null
        return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }
    }
  }

  private ok(id: JsonRpcRequest["id"], result: unknown): unknown {
    return { jsonrpc: "2.0", id: id ?? null, result }
  }

  // The site's canonical public URL(s): the custom domain(s) once set, else the
  // default <name>.<domain> subdomain (never both).
  private liveUrls(grant: ShareGrant): string[] {
    const site = this.deps.sites.get(grant.site)
    if (!site) return []
    const info = this.deps.sites.toInfo(site, this.deps.domain)
    return info.domains.length ? info.domains.map((d) => `https://${d}`) : [info.url]
  }

  // A compact context line attached to the tool result as a second content
  // block — so a client that drops `initialize` instructions still knows which
  // site it is editing and where it is live.
  private siteContextBlock(grant: ShareGrant): { type: "text"; text: string } {
    const urls = this.liveUrls(grant)
    const where = urls.length ? ` · live at ${urls.join(", ")}` : ""
    return { type: "text", text: `[editing site "${grant.site}"${where}]` }
  }

  private toolText(id: JsonRpcRequest["id"], grant: ShareGrant, text: string, isError = false): unknown {
    return {
      jsonrpc: "2.0",
      id: id ?? null,
      result: { content: [{ type: "text", text }, this.siteContextBlock(grant)], isError },
    }
  }

  private handleToolCall(msg: JsonRpcRequest, grant: ShareGrant, ctx: McpHostCtx, bearer: string): unknown {
    const params = (msg.params ?? {}) as { name?: string }
    if (params.name === "get_started") {
      return this.toolText(msg.id, grant, this.getStartedText(grant, ctx, bearer))
    }
    return this.toolText(msg.id, grant, `Unknown tool: ${params.name}`, true)
  }

  // The one and only tool: hand the connected AI a ready `siteio login` using
  // the current session's bearer as a scoped key, then the exact edit/deploy
  // recipe. The bearer is scoped to this one site (web files only, unless the
  // grant allows backend) and revocable by the owner at any time.
  private getStartedText(grant: ShareGrant, ctx: McpHostCtx, bearer: string): string {
    const site = grant.site
    const loginToken = encodeToken(`${ctx.baseUrl}/_siteio`, bearer)
    return [
      `You can edit and publish the website "${site}" (${ctx.baseUrl}) with the siteio CLI.`,
      "The CLI runs on macOS and Linux only (on Windows, use WSL).",
      "",
      "1. Install (once):",
      "   curl -LsSf https://siteio.houlahop.com/install | sh",
      "2. Log in with your scoped access (this token only works for this one site):",
      `   siteio login -t ${loginToken}`,
      "3. Download the current site, edit locally, and deploy:",
      `   siteio sites download -n ${site} ./${site}`,
      `   cd ${site}    # edit files; add images/fonts under the web root as normal files`,
      `   siteio sites deploy`,
      "",
      `Your access is limited to this one site's web files${grant.allowBackend ? " and backend" : ""}`,
      "and can be revoked by the owner at any time.",
    ].join("\n")
  }
}

const TOOL_DEFINITIONS = [
  {
    name: "get_started",
    description:
      "How to edit and publish this website. Returns a ready-to-run, scoped siteio CLI login plus the exact download/edit/deploy commands. Call this first; all editing happens through the siteio CLI.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
]
