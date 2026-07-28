import type { ShareGrant, SiteInfo } from "../../types.ts"
import type { GrantStore } from "./grant-store.ts"
import type { StagingStore } from "./staging-store.ts"
import type { SiteStorage } from "./storage.ts"
import type { OAuthStore } from "./oauth-store.ts"
import { ValidationError } from "../../utils/errors.ts"
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

// The two deliberately-distinct MCP surfaces, sharing one OAuth:
//   "mcp" — full editing tools (edit the site through MCP functions).
//   "cli" — a single get_started tool that hands off to the siteio CLI.
export type McpMode = "mcp" | "cli"

export interface McpDeps {
  grants: GrantStore
  staging: StagingStore
  sites: SiteStorage
  oauth: OAuthStore
  domain: string // base domain, for building the site's public URL(s)
  // Deploy a merged web+backend zip as a new version of `siteName`. Throws on
  // failure (missing site, Docker down, …). Provided by AgentServer.
  deploy: (siteName: string, zipData: Uint8Array, deployedBy: string) => Promise<SiteInfo>
  // Fetch an external asset by URL for write_url. SSRF-guarded + size-capped by
  // the server; throws on a disallowed or oversized target.
  fetchAsset: (url: string) => Promise<Uint8Array>
}

// A minimal Model Context Protocol server over Streamable HTTP, served per-site
// under the site host and authenticated by an OAuth bearer token (obtained via
// the share-code flow — see OAuthProvider). Two surfaces share the same auth:
//   - mode "mcp"  (`/mcp`): file-level editing tools over a per-grant staging copy.
//   - mode "cli"  (`/cli`): a single get_started tool that hands off to the CLI.
// Hand-rolled (initialize / tools/list / tools/call) to match the project's
// dependency-light HTTP layer.
export class McpHandler {
  constructor(private deps: McpDeps) {}

  private jsonRpcError(id: JsonRpcRequest["id"], code: number, message: string): Response {
    return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } })
  }

  // Entry point. `ctx` is the site resolved from the request Host by the server;
  // `mode` selects the tool surface. Auth is identical for both modes.
  async handle(req: Request, ctx: McpHostCtx, mode: McpMode): Promise<Response> {
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
      return this.challenge(ctx, mode)
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
        const res = await this.dispatch(msg as JsonRpcRequest, grant, ctx, bearer, mode)
        if (res !== null) responses.push(res)
      }
      if (responses.length === 0) return new Response(null, { status: 202 })
      return Response.json(responses)
    }

    const single = await this.dispatch(payload as JsonRpcRequest, grant, ctx, bearer, mode)
    if (single === null) return new Response(null, { status: 202 })
    return Response.json(single)
  }

  // 401 that points the client at this surface's protected-resource metadata,
  // so it can discover the OAuth authorization server and start the flow.
  private challenge(ctx: McpHostCtx, mode: McpMode): Response {
    return new Response(JSON.stringify({ error: "unauthorized", error_description: "Authorization required" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${ctx.baseUrl}/.well-known/oauth-protected-resource/${mode}"`,
      },
    })
  }

  // Returns a JSON-RPC response object, or null for a notification (no reply).
  private async dispatch(
    msg: JsonRpcRequest,
    grant: ShareGrant,
    ctx: McpHostCtx,
    bearer: string,
    mode: McpMode
  ): Promise<unknown | null> {
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
        const instructions =
          mode === "cli"
            ? `You can edit and publish the website "${grant.site}".${liveAt} ` +
              `Call the get_started tool first — it returns a scoped siteio CLI login and the exact ` +
              `commands to download the site, edit it locally (including images and other assets), and deploy.`
            : `You can edit and publish the website "${grant.site}".${liveAt} Use list_files/read_file to inspect it, ` +
              `write_file/delete_file to change the web files, then deploy_site to publish. ` +
              `Only website files can be changed here; the site's backend (database, hooks) is managed by the owner.`
        return this.ok(msg.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "siteio-site-editor", version: getVersion() },
          instructions,
        })
      }
      case "ping":
        return this.ok(msg.id, {})
      case "tools/list":
        return this.ok(msg.id, { tools: mode === "cli" ? CLI_TOOLS : MCP_TOOLS })
      case "tools/call":
        return this.handleToolCall(msg, grant, ctx, bearer, mode)
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

  private async handleToolCall(
    msg: JsonRpcRequest,
    grant: ShareGrant,
    ctx: McpHostCtx,
    bearer: string,
    mode: McpMode
  ): Promise<unknown> {
    const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
    const name = params.name
    const args = params.arguments ?? {}

    // The /cli surface exposes only get_started; the /mcp surface exposes only
    // the editing tools. Reject anything outside the active surface.
    const allowed = mode === "cli" ? name === "get_started" : name !== "get_started"
    if (!allowed) {
      return this.toolText(msg.id, grant, `Unknown tool: ${name}`, true)
    }

    try {
      switch (name) {
        case "site_info":
          return this.toolText(msg.id, grant, this.siteInfoText(grant))
        case "get_started":
          return this.toolText(msg.id, grant, this.getStartedText(grant, ctx, bearer))
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
        case "write_url": {
          this.ensureSeeded(grant)
          const path = String(args.path ?? "")
          const url = String(args.url ?? "")
          if (!url) return this.toolText(msg.id, grant, "url is required", true)
          const bytes = await this.deps.fetchAsset(url)
          this.deps.staging.writeBytes(grant.id, path, bytes)
          return this.toolText(msg.id, grant, `Fetched ${url} → ${path} (${bytes.length} bytes). Run deploy_site to publish.`)
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

  // Bridge for shell-capable clients (Codex, Claude Code, Cursor): hand back a
  // ready `siteio login` using the current session's bearer as a scoped key, so
  // the model can drop into the native CLI — download the real files, edit them
  // (images and all) with local tools, and deploy — instead of the MCP file
  // tools. The bearer is scoped to this one site exactly like the MCP session.
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

    this.deps.grants.touch(grant.id)
    this.deps.staging.setSeededVersion(grant.id, info.version ?? current + 1)

    let text = `Published to ${info.url} (version ${info.version}).`
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

// The /cli surface: a single hand-off tool.
const CLI_TOOLS = [
  {
    name: "get_started",
    description:
      "How to edit and publish this website. Returns a ready-to-run, scoped siteio CLI login plus the exact download/edit/deploy commands. Call this first; all editing happens through the siteio CLI.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
]

// The /mcp surface: full web-file editing tools.
const MCP_TOOLS = [
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
    name: "write_url",
    description:
      "Add a web file by having the server download it from a URL — the right way to add images, fonts, or other binary assets (no need to inline/base64 them). Staged, not published until deploy_site.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Destination path relative to the web root, e.g. img/hero.jpg" },
        url: { type: "string", description: "Public http(s) URL to fetch the file contents from" },
      },
      required: ["path", "url"],
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
    description: "Publish all staged web changes as a new live version of the site.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
]
