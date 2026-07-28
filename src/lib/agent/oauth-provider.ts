import type { GrantStore } from "./grant-store.ts"
import type { OAuthStore } from "./oauth-store.ts"
import type { SiteStorage } from "./storage.ts"
import { verifyPkceS256 } from "../../utils/oauth.ts"

// Access tokens are leases on a grant, re-checked (for revocation) on every MCP
// call — so they're long-lived and there are no refresh tokens. Revoking the
// grant drops its tokens immediately.
const TOKEN_TTL_MS = 3650 * 24 * 60 * 60 * 1000 // ~10 years

export interface OAuthDeps {
  grants: GrantStore
  oauth: OAuthStore
  sites: SiteStorage // for resolving custom-domain hosts to their owning site
  domain: string // base domain; the site is derived from the request host
}

// Context resolved from the incoming request's Host header. Every public URL is
// built from the site host — api.<domain> is never referenced.
interface HostCtx {
  baseUrl: string // https://<site>.<domain>
  site: string // <site>
}

// The agent's minimal OAuth 2.0 authorization server, hosted per-site. It turns
// a share code (grant token) into a bearer access token via the standard
// authorization-code + PKCE flow, so a share link works as a claude.ai / Claude
// Desktop custom connector. All endpoints live under the site host:
//   GET  /.well-known/oauth-protected-resource[/mcp]
//   GET  /.well-known/oauth-authorization-server[/mcp]
//   POST /mcp/oauth/register    (Dynamic Client Registration, RFC 7591)
//   GET  /mcp/oauth/authorize   (code-entry consent page)
//   POST /mcp/oauth/authorize   (validate code -> auth code -> redirect)
//   POST /mcp/oauth/token       (auth code + PKCE -> access token)
export class OAuthProvider {
  constructor(private deps: OAuthDeps) {}

  // Resolve the site context from a host header, or null if the host isn't a
  // servable site. Two cases: the default `<site>.<domain>` subdomain, or a
  // site's custom domain (resolved via SiteStorage). `baseUrl` is always the
  // host the client actually connected to, so every OAuth URL stays on it.
  hostContext(host: string): HostCtx | null {
    const bare = host.split(":")[0] || ""
    const suffix = `.${this.deps.domain}`
    if (bare.endsWith(suffix)) {
      const site = bare.slice(0, bare.length - suffix.length)
      if (!site || site === "api" || !/^[a-z0-9-]+$/.test(site)) return null
      return { baseUrl: `https://${bare}`, site }
    }
    // Custom (vanity) domain → its owning site.
    const owner = this.deps.sites.findByCustomDomain(bare, this.deps.domain)
    if (!owner) return null
    return { baseUrl: `https://${bare}`, site: owner.name }
  }

  private cors(headers: Record<string, string> = {}): Record<string, string> {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-protocol-version",
      ...headers,
    }
  }

  preflight(): Response {
    return new Response(null, { status: 204, headers: this.cors() })
  }

  private jsonCors(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: this.cors({ "Content-Type": "application/json" }),
    })
  }

  private oauthError(error: string, description: string, status = 400): Response {
    return this.jsonCors({ error, error_description: description }, status)
  }

  // ---- Discovery metadata ----

  protectedResourceMetadata(ctx: HostCtx): Response {
    return this.jsonCors({
      resource: `${ctx.baseUrl}/mcp`,
      authorization_servers: [ctx.baseUrl],
      scopes_supported: ["site:edit"],
      bearer_methods_supported: ["header"],
    })
  }

  authorizationServerMetadata(ctx: HostCtx): Response {
    return this.jsonCors({
      issuer: ctx.baseUrl,
      authorization_endpoint: `${ctx.baseUrl}/mcp/oauth/authorize`,
      token_endpoint: `${ctx.baseUrl}/mcp/oauth/token`,
      registration_endpoint: `${ctx.baseUrl}/mcp/oauth/register`,
      scopes_supported: ["site:edit"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    })
  }

  // ---- Dynamic Client Registration ----

  async handleRegister(req: Request): Promise<Response> {
    let body: { redirect_uris?: unknown; client_name?: unknown }
    try {
      body = (await req.json()) as typeof body
    } catch {
      return this.oauthError("invalid_client_metadata", "Body must be JSON")
    }
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u))
      : []
    if (redirectUris.length === 0) {
      return this.oauthError("invalid_redirect_uri", "At least one https redirect_uri is required")
    }
    const client = this.deps.oauth.registerClient({
      redirectUris,
      clientName: typeof body.client_name === "string" ? body.client_name : undefined,
    })
    return this.jsonCors(
      {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        ...(client.clientName ? { client_name: client.clientName } : {}),
      },
      201
    )
  }

  // ---- Authorization endpoint ----

  handleAuthorizeGet(url: URL, ctx: HostCtx): Response {
    const p = url.searchParams
    const check = this.validateAuthorizeParams(p, ctx)
    if ("error" in check) {
      // Parameter problems that predate a valid redirect are shown to the user,
      // not redirected (can't trust an unvalidated redirect_uri).
      return new Response(this.renderPage(ctx, p, check.error), {
        status: 400,
        headers: this.cors({ "Content-Type": "text/html; charset=utf-8" }),
      })
    }
    return new Response(this.renderPage(ctx, p, null), {
      headers: this.cors({ "Content-Type": "text/html; charset=utf-8" }),
    })
  }

  async handleAuthorizePost(req: Request, ctx: HostCtx): Promise<Response> {
    const form = new URLSearchParams(await req.text())
    const check = this.validateAuthorizeParams(form, ctx)
    if ("error" in check) {
      return new Response(this.renderPage(ctx, form, check.error), {
        status: 400,
        headers: this.cors({ "Content-Type": "text/html; charset=utf-8" }),
      })
    }
    const { redirectUri } = check

    // The share code IS the credential. Validate it against a live grant for
    // THIS site (a code for another site can't authorize here).
    const code = (form.get("code") || "").trim()
    const grant = this.deps.grants.resolveByToken(code)
    if (!grant || grant.site !== ctx.site) {
      return new Response(
        this.renderPage(ctx, form, "That code is invalid, expired, or used up. Ask the site owner for a fresh one."),
        { status: 401, headers: this.cors({ "Content-Type": "text/html; charset=utf-8" }) }
      )
    }

    const authCode = this.deps.oauth.createAuthCode({
      grantId: grant.id,
      clientId: form.get("client_id")!,
      redirectUri,
      codeChallenge: form.get("code_challenge")!,
    })

    const redirect = new URL(redirectUri)
    redirect.searchParams.set("code", authCode)
    const state = form.get("state")
    if (state) redirect.searchParams.set("state", state)
    return new Response(null, { status: 302, headers: { Location: redirect.toString() } })
  }

  // Shared param validation for GET/POST authorize. Returns the validated
  // redirect_uri or an error message.
  private validateAuthorizeParams(
    p: URLSearchParams,
    _ctx: HostCtx
  ): { redirectUri: string } | { error: string } {
    if (p.get("response_type") !== "code") return { error: "Unsupported response_type (only 'code')." }
    const clientId = p.get("client_id") || ""
    const client = this.deps.oauth.getClient(clientId)
    if (!client) return { error: "Unknown client. Try removing and re-adding the connector." }
    const redirectUri = p.get("redirect_uri") || ""
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return { error: "redirect_uri does not match the registered client." }
    }
    if (p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) {
      return { error: "PKCE with S256 is required." }
    }
    return { redirectUri }
  }

  // ---- Token endpoint ----

  async handleToken(req: Request, ctx: HostCtx): Promise<Response> {
    const form = new URLSearchParams(await req.text())
    if (form.get("grant_type") !== "authorization_code") {
      return this.oauthError("unsupported_grant_type", "Only authorization_code is supported")
    }
    const code = form.get("code") || ""
    const record = this.deps.oauth.consumeAuthCode(code)
    if (!record) return this.oauthError("invalid_grant", "Authorization code is invalid or expired")

    if (form.get("client_id") !== record.clientId) {
      return this.oauthError("invalid_grant", "client_id mismatch")
    }
    if (form.get("redirect_uri") !== record.redirectUri) {
      return this.oauthError("invalid_grant", "redirect_uri mismatch")
    }
    if (!verifyPkceS256(form.get("code_verifier") || "", record.codeChallenge)) {
      return this.oauthError("invalid_grant", "PKCE verification failed")
    }

    const grant = this.deps.grants.get(record.grantId)
    if (!grant || !this.deps.grants.isActive(grant) || grant.site !== ctx.site) {
      return this.oauthError("invalid_grant", "The share code is no longer valid")
    }

    // Long-lived token; the grant is re-checked on every MCP call, so a revoke
    // bites immediately regardless of token lifetime.
    const now = Date.now()
    const expiresAtMs = now + TOKEN_TTL_MS
    const token = this.deps.oauth.createAccessToken({
      grantId: grant.id,
      expiresAt: new Date(expiresAtMs).toISOString(),
    })
    return this.jsonCors({
      access_token: token,
      token_type: "Bearer",
      expires_in: Math.max(1, Math.floor((expiresAtMs - now) / 1000)),
      scope: "site:edit",
    })
  }

  // ---- Consent page ----

  private renderPage(ctx: HostCtx, p: URLSearchParams, error: string | null): string {
    const carry = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"]
    const hidden = carry
      .map((k) => (p.get(k) ? `<input type="hidden" name="${k}" value="${escapeHtml(p.get(k)!)}">` : ""))
      .join("\n")
    const errorHtml = error ? `<p class="err">${escapeHtml(error)}</p>` : ""
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to ${escapeHtml(ctx.site)}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:420px;margin:80px auto;padding:24px;color:#1a1a1a}
  h1{font-size:20px} p{color:#555;line-height:1.5}
  code{background:#f3f3f3;padding:2px 6px;border-radius:4px}
  input[type=text]{width:100%;padding:12px;font-size:16px;border:1px solid #ccc;border-radius:8px;box-sizing:border-box;font-family:ui-monospace,monospace}
  button{margin-top:16px;width:100%;padding:12px;font-size:16px;background:#111;color:#fff;border:0;border-radius:8px;cursor:pointer}
  .err{color:#c0202f;background:#fdeef0;padding:10px 12px;border-radius:8px}
  .site{font-weight:600;color:#111}
</style></head>
<body>
  <h1>Edit <span class="site">${escapeHtml(ctx.site)}</span></h1>
  <p>Enter the share code the site owner gave you to let this app edit and publish <code>${escapeHtml(ctx.site)}</code>.</p>
  ${errorHtml}
  <form method="POST">
    ${hidden}
    <input type="text" name="code" placeholder="grt_…" autocomplete="off" autofocus required>
    <button type="submit">Authorize</button>
  </form>
</body></html>`
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
