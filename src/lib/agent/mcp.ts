import type { ShareGrant, SiteInfo } from "../../types.ts"
import type { GrantStore } from "./grant-store.ts"
import type { StagingStore } from "./staging-store.ts"
import type { SiteStorage } from "./storage.ts"
import type { OAuthStore } from "./oauth-store.ts"
import { ValidationError } from "../../utils/errors.ts"
import { getVersion } from "../version.ts"

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
  staging: StagingStore
  sites: SiteStorage
  oauth: OAuthStore
  domain: string // base domain, for building the site's public URL(s)
  // Deploy a merged web+backend zip as a new version of `siteName`. Throws on
  // failure (missing site, Docker down, …). Provided by AgentServer.
  deploy: (siteName: string, zipData: Uint8Array, deployedBy: string) => Promise<SiteInfo>
}

// A minimal Model Context Protocol server over Streamable HTTP, served per-site
// at `https://<site>.<domain>/mcp` and authenticated by an OAuth bearer token
// (obtained by the client via the share-code flow — see OAuthProvider). Exposes
// file-level tools scoped to one site's web root, backed by a per-grant staging
// copy. Hand-rolled (initialize / tools/list / tools/call) to match the
// project's dependency-light HTTP layer.
export class McpHandler {
  constructor(private deps: McpDeps) {}

  private jsonRpcError(id: JsonRpcRequest["id"], code: number, message: string): Response {
    return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } })
  }

  // Entry point. `ctx` is the site resolved from the request Host by the server.
  async handle(req: Request, ctx: McpHostCtx): Promise<Response> {
    if (req.method !== "POST") {
      // We don't offer a server-initiated GET stream; tell compliant clients.
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } })
    }

    // Bearer auth: the client obtained this token via the OAuth share-code flow.
    const auth = req.headers.get("authorization") || ""
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : ""
    const record = bearer ? this.deps.oauth.resolveAccessToken(bearer) : null
    const grant = record ? this.deps.grants.get(record.grantId) : null
    // The token must map to a live grant for THIS site.
    if (!grant || !this.deps.grants.isActive(grant) || grant.site !== ctx.site) {
      return this.challenge(ctx)
    }

    let payload: unknown
    try {
      payload = await req.json()
    } catch {
      return this.jsonRpcError(null, -32700, "Parse error")
    }

    // Support a single message or a batch.
    if (Array.isArray(payload)) {
      const responses: unknown[] = []
      for (const msg of payload) {
        const res = await this.dispatch(msg as JsonRpcRequest, grant)
        if (res !== null) responses.push(res)
      }
      if (responses.length === 0) return new Response(null, { status: 202 })
      return Response.json(responses)
    }

    const single = await this.dispatch(payload as JsonRpcRequest, grant)
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

  // Returns a JSON-RPC response object, or null for a notification (no reply).
  private async dispatch(msg: JsonRpcRequest, grant: ShareGrant): Promise<unknown | null> {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return { jsonrpc: "2.0", id: (msg && msg.id) ?? null, error: { code: -32600, message: "Invalid Request" } }
    }

    // Notifications carry no id and expect no response.
    const isNotification = msg.id === undefined || msg.id === null
    if (msg.method.startsWith("notifications/")) return null

    switch (msg.method) {
      case "initialize": {
        const site = this.deps.sites.get(grant.site)
        const info = site ? this.deps.sites.toInfo(site, this.deps.domain) : null
        // Report the custom domain(s) once set — that becomes the canonical
        // public URL; otherwise fall back to the default <name>.<domain>.
        const liveUrls = info
          ? info.domains.length
            ? info.domains.map((d) => `https://${d}`)
            : [info.url]
          : []
        const liveAt = liveUrls.length ? ` It is live at ${liveUrls.join(", ")}.` : ""
        return this.ok(msg.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "siteio-site-editor", version: getVersion() },
          instructions:
            `You can edit and publish the website "${grant.site}".${liveAt} Use list_files/read_file to inspect it, ` +
            `write_file/delete_file to change the web files, then deploy_site to publish. ` +
            `Only website files can be changed here; the site's backend (database, hooks) is managed by the owner.`,
        })
      }
      case "ping":
        return this.ok(msg.id, {})
      case "tools/list":
        return this.ok(msg.id, { tools: TOOL_DEFINITIONS })
      case "tools/call":
        return this.handleToolCall(msg, grant)
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

  // A compact context line attached to EVERY tool result as a second content
  // block — so a client that drops `initialize` instructions still keeps the
  // model aware of which site it's editing, where it's live, and its budget.
  private siteContextBlock(grant: ShareGrant): { type: "text"; text: string } {
    const g = this.deps.grants.get(grant.id) ?? grant // fresh budget after a deploy
    const urls = this.liveUrls(g)
    const where = urls.length ? ` · live at ${urls.join(", ")}` : ""
    const remaining = Math.max(0, g.maxDeploys - g.deploysUsed)
    return { type: "text", text: `[editing site "${g.site}"${where} · ${remaining} deploy(s) left on this link]` }
  }

  private toolText(id: JsonRpcRequest["id"], grant: ShareGrant, text: string, isError = false): unknown {
    return {
      jsonrpc: "2.0",
      id: id ?? null,
      result: { content: [{ type: "text", text }, this.siteContextBlock(grant)], isError },
    }
  }

  private async handleToolCall(msg: JsonRpcRequest, grant: ShareGrant): Promise<unknown> {
    const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
    const name = params.name
    const args = params.arguments ?? {}

    try {
      switch (name) {
        case "site_info":
          return this.toolText(msg.id, grant, this.siteInfoText(grant))
        case "list_files": {
          this.ensureSeeded(grant)
          const files = this.deps.staging.listFiles(grant.id)
          return this.toolText(msg.id, grant, files.length ? files.join("\n") : "(no files)")
        }
        case "read_file": {
          this.ensureSeeded(grant)
          const { content, encoding } = this.deps.staging.readFile(grant.id, String(args.path ?? ""))
          const prefix = encoding === "base64" ? "[base64-encoded binary file]\n" : ""
          return this.toolText(msg.id, grant, prefix + content)
        }
        case "write_file": {
          this.ensureSeeded(grant)
          const encoding = args.encoding === "base64" ? "base64" : "utf8"
          this.deps.staging.writeFile(grant.id, String(args.path ?? ""), String(args.content ?? ""), encoding)
          return this.toolText(msg.id, grant, `Wrote ${args.path}. Run deploy_site to publish.`)
        }
        case "delete_file": {
          this.ensureSeeded(grant)
          const removed = this.deps.staging.deleteFile(grant.id, String(args.path ?? ""))
          return this.toolText(msg.id, grant, removed ? `Deleted ${args.path}.` : `File not found: ${args.path}`, !removed)
        }
        case "deploy_site":
          return this.handleDeployTool(msg, grant)
        default:
          return this.toolText(msg.id, grant, `Unknown tool: ${name}`, true)
      }
    } catch (err) {
      const message = err instanceof ValidationError ? err.message : err instanceof Error ? err.message : String(err)
      return this.toolText(msg.id, grant, message, true)
    }
  }

  // Structured summary for the site_info tool: where it's live plus the current
  // published version, so the model can reference the URL without deploying.
  private siteInfoText(grant: ShareGrant): string {
    const site = this.deps.sites.get(grant.site)
    if (!site) return `Site "${grant.site}" no longer exists.`
    const info = this.deps.sites.toInfo(site, this.deps.domain)
    const canonical = info.domains.length ? info.domains.map((d) => `https://${d}`) : [info.url]
    const lines = [
      `Site: ${grant.site}`,
      `Live at: ${canonical.join(", ")}`,
      info.domains.length
        ? `Custom domains: ${info.domains.join(", ")}`
        : `Default subdomain: ${info.url}`,
      `Current published version: ${info.version ?? "not yet published"}`,
    ]
    return lines.join("\n")
  }

  private async handleDeployTool(msg: JsonRpcRequest, grant: ShareGrant): Promise<unknown> {
    this.ensureSeeded(grant)
    const site = this.deps.sites.get(grant.site)
    if (!site) return this.toolText(msg.id, grant, `Site "${grant.site}" no longer exists.`, true)

    const seeded = this.deps.staging.seededVersion(grant.id)
    const current = site.version ?? 0
    const rebased = current !== seeded // owner (or another link) deployed mid-session

    const zip = this.deps.staging.buildDeployZip(grant.id, this.deps.sites.getCodePath(grant.site))
    const deployedBy = grant.label || "shared link"
    const info = await this.deps.deploy(grant.site, zip, deployedBy)

    const updated = this.deps.grants.recordDeploy(grant.id)
    this.deps.staging.setSeededVersion(grant.id, info.version ?? current + 1)

    const remaining = updated ? updated.maxDeploys - updated.deploysUsed : 0
    let text = `Published to ${info.url} (version ${info.version}). ${remaining} deploy(s) remaining on this link.`
    if (rebased) {
      text +=
        `\n\nNote: the site had changed since you started editing — your web changes were published on top of the latest version. ` +
        `If something looks off, re-run list_files/read_file to review the current files.`
    }
    return this.toolText(msg.id, grant, text)
  }

  private ensureSeeded(grant: ShareGrant): void {
    const site = this.deps.sites.get(grant.site)
    if (!site) throw new ValidationError(`Site "${grant.site}" no longer exists.`)
    if (!this.deps.staging.isSeeded(grant.id)) {
      this.deps.staging.seed(grant.id, this.deps.sites.getCodePath(grant.site), site.version ?? 0)
    }
  }
}

const TOOL_DEFINITIONS = [
  {
    name: "site_info",
    description:
      "Get the site's public URL(s) and current published version. The URL is the custom domain if one is set, otherwise the default subdomain.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_files",
    description: "List all web files of the site you can edit (relative paths).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_file",
    description: "Read the contents of one web file. Binary files are returned base64-encoded.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "File path relative to the web root, e.g. index.html" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a web file (staged, not published until deploy_site). Only website files can be changed; backend code is off-limits.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the web root, e.g. css/style.css" },
        content: { type: "string", description: "File contents" },
        encoding: { type: "string", enum: ["utf8", "base64"], description: "Content encoding (default utf8)" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_file",
    description: "Delete a staged web file (not published until deploy_site).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "File path relative to the web root" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "deploy_site",
    description: "Publish all staged web changes as a new live version of the site. Consumes one deploy from the link's budget.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
]
