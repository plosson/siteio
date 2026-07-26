import type { ShareGrant, SiteInfo } from "../../types.ts"
import type { GrantStore } from "./grant-store.ts"
import type { StagingStore } from "./staging-store.ts"
import type { SiteStorage } from "./storage.ts"
import { ValidationError } from "../../utils/errors.ts"
import { isWellFormedGrantToken } from "../../utils/grant-token.ts"
import { getVersion } from "../version.ts"

const MCP_PROTOCOL_VERSION = "2024-11-05"

// JSON-RPC 2.0 shapes (only the slice MCP needs).
interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export interface McpDeps {
  grants: GrantStore
  staging: StagingStore
  sites: SiteStorage
  domain: string // base domain, for building the site's public URL(s)
  // Deploy a merged web+backend zip as a new version of `siteName`. Throws on
  // failure (missing site, Docker down, …). Provided by AgentServer.
  deploy: (siteName: string, zipData: Uint8Array, deployedBy: string) => Promise<SiteInfo>
}

// A minimal Model Context Protocol server over Streamable HTTP, authenticated
// by a share-grant token in the URL path (`/mcp/<token>`). Exposes five
// file-level tools scoped to one site's web root, backed by a per-grant staging
// copy. Deliberately hand-rolled (initialize / tools/list / tools/call) to
// match the project's dependency-light HTTP layer.
export class McpHandler {
  constructor(private deps: McpDeps) {}

  private jsonRpcError(id: JsonRpcRequest["id"], code: number, message: string): Response {
    return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } })
  }

  private jsonRpcResult(id: JsonRpcRequest["id"], result: unknown): Response {
    return Response.json({ jsonrpc: "2.0", id: id ?? null, result })
  }

  // Entry point. `path` is the request pathname (e.g. "/mcp/grt_...").
  async handle(req: Request, path: string): Promise<Response> {
    const match = path.match(/^\/mcp\/([^/]+)\/?$/)
    if (!match) return this.unauthorized("Malformed MCP endpoint")
    const token = decodeURIComponent(match[1]!)

    if (!isWellFormedGrantToken(token)) return this.unauthorized("Invalid share link")

    const grant = this.deps.grants.resolveByToken(token)
    if (!grant) return this.unauthorized("This share link is invalid, expired, revoked, or used up")

    // Streamable HTTP: clients POST JSON-RPC. We don't offer a server-initiated
    // GET stream — tell compliant clients so explicitly.
    if (req.method === "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } })
    }
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } })
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

  private unauthorized(message: string): Response {
    return Response.json({ error: message }, { status: 401 })
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

  private toolText(id: JsonRpcRequest["id"], text: string, isError = false): unknown {
    return { jsonrpc: "2.0", id: id ?? null, result: { content: [{ type: "text", text }], isError } }
  }

  private async handleToolCall(msg: JsonRpcRequest, grant: ShareGrant): Promise<unknown> {
    const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
    const name = params.name
    const args = params.arguments ?? {}

    try {
      switch (name) {
        case "list_files": {
          this.ensureSeeded(grant)
          const files = this.deps.staging.listFiles(grant.id)
          return this.toolText(msg.id, files.length ? files.join("\n") : "(no files)")
        }
        case "read_file": {
          this.ensureSeeded(grant)
          const { content, encoding } = this.deps.staging.readFile(grant.id, String(args.path ?? ""))
          const prefix = encoding === "base64" ? "[base64-encoded binary file]\n" : ""
          return this.toolText(msg.id, prefix + content)
        }
        case "write_file": {
          this.ensureSeeded(grant)
          const encoding = args.encoding === "base64" ? "base64" : "utf8"
          this.deps.staging.writeFile(grant.id, String(args.path ?? ""), String(args.content ?? ""), encoding)
          return this.toolText(msg.id, `Wrote ${args.path}. Run deploy_site to publish.`)
        }
        case "delete_file": {
          this.ensureSeeded(grant)
          const removed = this.deps.staging.deleteFile(grant.id, String(args.path ?? ""))
          return this.toolText(msg.id, removed ? `Deleted ${args.path}.` : `File not found: ${args.path}`, !removed)
        }
        case "deploy_site":
          return this.handleDeployTool(msg, grant)
        default:
          return this.toolText(msg.id, `Unknown tool: ${name}`, true)
      }
    } catch (err) {
      const message = err instanceof ValidationError ? err.message : err instanceof Error ? err.message : String(err)
      return this.toolText(msg.id, message, true)
    }
  }

  private async handleDeployTool(msg: JsonRpcRequest, grant: ShareGrant): Promise<unknown> {
    this.ensureSeeded(grant)
    const site = this.deps.sites.get(grant.site)
    if (!site) return this.toolText(msg.id, `Site "${grant.site}" no longer exists.`, true)

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
    return this.toolText(msg.id, text)
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
