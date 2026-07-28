# Single-use MCP share links for site editing

**Status:** Architecture / design
**Date:** 2026-07-26
**Goal:** Let a site owner mint a shareable **MCP connector** that a second person (via their own AI client) can use to edit and redeploy *one* site — with owner-set usage limits, real revocation, and no exposure of the god API key.

---

## v2 (2026-07-27): OAuth per-site — supersedes token-in-URL

Shipped as `1.20.0` with a **token-in-URL** auth model (`…/mcp/<token>`). That works with Claude Code / Cursor / `mcp-remote`, but **claude.ai's connector UI requires OAuth** (it does Dynamic Client Registration and fails against a token URL). v2 replaces the auth model entirely (no backward compat) with a **minimal per-site OAuth 2.0 authorization server**, so a share link works as a first-class claude.ai / Claude Desktop custom connector. Sections §4/§8 (StagingStore, deploy merge, staging GC, path/size hardening) are unchanged; the auth/transport sections below are superseded by this one.

**Model.** `siteio sites share <site>` now prints a **connector URL** (`https://<site>.<domain>/mcp`, identical for everyone) **and a one-time share code** (the grant token). The per-invitee secret moved out of the URL into the OAuth consent step — so the URL is stable/shareable and each code is its own revocable grant.

**Everything is per-site; `api.<domain>` is never exposed.** All OAuth endpoints are served under the site host, and every URL in metadata/redirects is built from the request `Host` (never the api host). The agent refuses these paths on `api.<domain>`.

**Endpoints** (served by `OAuthProvider`, dispatched before the api-host gate, no god key):

| Path (under `<site>.<domain>`) | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource[/mcp]` | RFC 9728 — points at the AS (the site host itself) |
| `GET /.well-known/oauth-authorization-server[/mcp]` | RFC 8414 — advertises the endpoints below + `S256` PKCE |
| `POST /mcp/oauth/register` | Dynamic Client Registration (RFC 7591) → `client_id` |
| `GET /mcp/oauth/authorize` | Consent page: "enter your share code" |
| `POST /mcp/oauth/authorize` | Validate code → grant (must match host's site) → 302 with single-use auth code |
| `POST /mcp/oauth/token` | Auth code + PKCE verifier → bearer **access token** (leased to the grant) |
| `POST /mcp` | JSON-RPC MCP, `Authorization: Bearer <token>`; 401 + `WWW-Authenticate` when missing |

**Flow.** discover → DCR → authorize (paste code) → token → MCP over Bearer. The access token is a *lease* on the grant: every MCP call re-checks the grant, so revoke/expiry/budget bite immediately; token lifetime tracks the grant (long-lived for `--expires never`), so no refresh tokens are needed.

**New stores/files:** `OAuthStore` (`oauth/{clients,authcodes,tokens}`), `oauth.ts` (PKCE S256 + id/token gen), `OAuthProvider` (endpoints + consent page). `GrantStore`/`StagingStore` reused as-is; the grant token is now the "code".

**Traefik:** the `mcp-router` rule additionally routes `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` (alongside `/mcp`) on the site host to the agent.

**Security:** PKCE S256 mandatory; single-use, short-TTL auth codes; strict `redirect_uri` match per registered client; a code for site A can't authorize on site B's host; revoking a grant drops its access tokens; the code is entered in a form (not left in a URL/history). Follow-up worth considering: rate-limit the `authorize` endpoint.

---

## v3 (2026-07-28): two tiers — scoped CLI + MCP connector

v2 added the MCP-over-OAuth connector for **tool-only** clients (claude.ai). But **shell-capable coding agents** (Codex, Claude Code, Cursor) are better served editing real local files with the **standard CLI** — native file ops, images-as-files, local preview — than through reimplemented MCP file tools. v3 adds that as a second tier on the same grant foundation. Both tiers ship together.

**Tier A — scoped CLI (coding agents).** The share **code becomes a scoped credential** for the *standard* `siteio` CLI (no custom client). `sites share` now also emits a `siteio login -t <cliToken>`. The invitee runs `login` → `sites download` → edit → `sites deploy`.
- **Transport keeps `api.<domain>` hidden:** the CLI logs in against `https://<site>.<domain>/_siteio` (a reserved prefix Traefik siphons to the agent alongside `/mcp`), so scoped REST never touches the api host and never steals `/sites`/`/health` from the site container.
- **Agent auth (`authenticate()`):** the god key → full access; a **grant token** *or* an **OAuth bearer** (as `X-API-Key`) → a narrow per-site scope (`handleScopedRequest`): only `GET download` and `POST deploy` for the grant's own site; everything else 403. Deploys are budget-counted and label-attributed.
- **Backend safety = one shared rule (`mergeScopedDeploy`)** used by both tiers: web root from the invitee, backend (`pb_migrations`/`pb_hooks`) preserved from current code — unless the grant has `allowBackend` (owner opt-in via `share --allow-backend`), which lets the invitee replace a backend dir they actually supplied.

**Tier B — MCP connector, two deliberate surfaces** (per-site OAuth from v2, shared across both):
- **`/mcp`** — the full web-file editing tools (`site_info`, `list_history`, `list_files`, `read_file`, `write_file`, `write_url`, `delete_file`, `deploy_site`) over a per-grant `StagingStore`. `list_history` returns the deployment changelog (current + archived versions, newest first, with timestamp + author). Pure MCP functions: the AI edits through tool calls. `write_url(path, url)` has the agent fetch a URL server-side into a staged web file (the clean way to add images/binary assets without inlining) — SSRF-guarded (`assertSafePublicUrl`: http(s) only, no private/reserved addresses, no redirects, size-capped).
- **`/cli`** — a single `get_started` tool returning a scoped `siteio login` (built from the session bearer) + the download/edit/deploy recipe. The "MCP-as-CLI-bridge" pattern: one thin delegation tool that hands off to the CLI (for shell-capable clients; images/assets are just local files).

Both endpoints authenticate identically (OAuth bearer → grant for this site); a single bearer from the dance works on both. Each advertises its own RFC 9728 protected-resource (`/.well-known/oauth-protected-resource/{mcp,cli}`) pointing at the one shared authorization server. `tools/call` on a surface rejects the other surface's tools.

**Custom (vanity) domains.** The sharing endpoints work on a site's custom domain too, not only `<site>.<domain>`. The Traefik `mcp-router` rule is host-agnostic (matches the reserved path prefixes on *any* host, high priority) and `OAuthProvider.hostContext` resolves a custom-domain host to its owning site via `SiteStorage.findByCustomDomain`. Every OAuth/MCP URL is built from the host the client actually connected to, so a connector added on the vanity domain stays on it end-to-end. Reserved paths (`/mcp`, `/cli`, `/_siteio`, `/.well-known/oauth-*`) are therefore not usable as site content on any host.

**Result:** the owner sends whichever fits the invitee's client — CLI login (Tier A), the `/mcp` connector (edit-in-AI), or the `/cli` connector (bridge to CLI). Same `GrantStore` and revoke-only lifetime across all. (This split supersedes the single-tool-only v3 draft.)

---

## 1. What we're building (one paragraph)

`siteio sites share <name>` prints a URL like `https://<site>.<domain>/mcp/<grant-token>`. The invitee pastes it into an MCP client (Claude Desktop, Cursor, …). Their AI gets a small tool set — `list_files`, `read_file`, `write_file`, `delete_file`, `deploy_site` — operating on a **server-side staging copy** of the site's **web root only**. On deploy, the agent merges the edited `public/` with the site's existing backend (`pb_migrations`, `pb_hooks`) and runs the normal site-deploy path. The grant is a stored, hashed, revocable record with an owner-set deploy budget and TTL; the default is single-use (1 deploy).

---

## 2. Locked decisions (from clarification)

| # | Question | Decision |
|---|----------|----------|
| 1 | Capability scope | **Edit + redeploy one site only** — no other sites/apps, no logs/admin/domains/delete. |
| 2 | Link lifetime | **Owner-set**: `--deploys N` and/or `--expires <dur>`; **default = 1 deploy**. |
| 3 | MCP hosting | **Inside the existing agent server**, served under the **site's host**: `<site>.<domain>/mcp/<token>`. |
| 4 | Edit model | **File-level tools + per-grant server-side staging dir.** |
| 5 | Grant storage | **New hashed grant store** under the data dir (mirrors `SiteStorage`/`AppStorage`). |
| 6 | Owner UX | **Full `sites share` group**: create / list / revoke, via new authed `/sites/:name/grants` routes. |
| 7 | Attribution & concurrency | **Grant label → `X-Deployed-By`; auto-rebase to latest**, friendly "site changed, re-sync" MCP error. |
| 8 | Editable surface | **Web root (`public/`) only**; backend dirs preserved server-side and re-attached at deploy. |
| 9 | Target client | **Token-in-URL, Streamable HTTP**; OAuth deferred but abstraction left open. |
| 10 | Guardrails v1 | **Path & size hardening** + **auto-expiry & staging GC**. (Rate-limit + preview/confirm = future.) |

---

## 3. Architecture overview

```
Owner CLI                          Agent server (Bun.serve, api.<domain>)
─────────                          ─────────────────────────────────────
siteio sites share mysite  ──POST /sites/mysite/grants──►  GrantStore.create()
                           ◄──── { token, url } ─────────  (returns raw token ONCE)
   prints:
   https://mysite.<domain>/mcp/<token>


Invitee's MCP client
────────────────────
  connects to  https://mysite.<domain>/mcp/<token>
        │
        ▼
   Traefik  ──(file router: Host=*.<domain> && PathPrefix(/mcp), higher priority)──►  Agent
        │                                                                                │
        │  (Host(mysite.<domain>) alone, lower priority)                                 ▼
        └────────────────────────────────────────────►  site container            McpHandler
                                                                                        │
                                              validate token ─► GrantStore.resolve()    │
                                              first use ─► seed StagingStore from        │
                                                            site code (public/ only)     │
                                              tools ─► read/write staging                │
                                              deploy ─► merge public/ + backend ─► normal deploy path
```

Two new subsystems, both **inside the agent process**:

1. **`GrantStore`** — persistence + lifecycle of share grants.
2. **`McpHandler`** — a minimal MCP-over-Streamable-HTTP endpoint that authenticates by token, manages a per-grant **staging working copy**, and exposes the five tools.

Plus **one Traefik file-provider router** so `<site>/mcp/*` reaches the agent instead of the site container.

---

## 4. Data model

### `ShareGrant` (new type in `src/types.ts`)

```ts
export interface ShareGrant {
  id: string                 // short public id, e.g. "grt_ab12cd" — used in `share list/revoke`
  site: string               // site name this grant is scoped to
  tokenHash: string          // sha-256 of the raw token; raw token is NEVER stored
  label?: string             // optional, surfaced as X-Deployed-By (e.g. "shared with Sam")
  maxDeploys: number         // owner-set; default 1
  deploysUsed: number
  createdAt: string
  expiresAt: string          // owner-set OR createdAt + HARD_MAX_TTL, whichever is sooner
  lastUsedAt?: string
  revoked: boolean
}
```

**Raw token** = `grt_` + 32 bytes base64url of `crypto.getRandomValues`. Returned to the owner exactly once (in the `POST /grants` response); only its hash is persisted — same discipline as never re-showing a password.

### `GrantStore` (`src/lib/agent/grant-store.ts`) — mirrors `AppStorage`

Files under `SITEIO_DATA_DIR/share-grants/<id>.json`. Methods:

```ts
create(site, { maxDeploys, expiresAt, label }): { grant: ShareGrant; token: string }
listForSite(site): ShareGrant[]
resolveByToken(token): ShareGrant | null   // hash lookup + validity check (not expired/revoked/exhausted)
recordDeploy(id): ShareGrant | null        // deploysUsed++, lastUsedAt=now
revoke(id): boolean
gc(): void                                 // delete expired/revoked/exhausted + their staging dirs
```

`resolveByToken` is the single chokepoint deciding a grant is *live*: `!revoked && now < expiresAt && deploysUsed < maxDeploys`.

> **Note on `Date.now()`**: agent code runs normally (this constraint only applies to Workflow scripts), so real timestamps are fine here.

### `StagingStore` (`src/lib/agent/staging-store.ts`)

Per-grant scratch web root at `SITEIO_DATA_DIR/share-staging/<grantId>/`. Holds **only** the `public/` tree (flattened to the invitee's view — they see `index.html`, not `public/index.html`). Created lazily on the grant's first file operation by copying the site's current code `public/` subtree via `SiteStorage.getCodePath(site)`. Removed by `GrantStore.gc()` when the grant dies.

---

## 5. Routing: `<site>.<domain>/mcp/*` → agent

Add one router to `TraefikManager.generateDynamicConfig()` alongside `api-router`:

```yaml
mcp-router:
  rule: "HostRegexp(`^[a-z0-9-]+\\.<domain>$`) && PathPrefix(`/mcp`)"
  entryPoints: ["websecure"]
  service: "api-service"          # reuse the existing agent service
  priority: 1000                  # beat the Host-only container routers
  tls:
    certResolver: "letsencrypt"
```

- **Why it works:** container routers are `Host(<site>.<domain>)` (rule length ≈ short, default priority low). Our rule is `Host + PathPrefix` and we set an explicit high `priority`, so `/mcp/*` is captured by the agent while every other path on that host still falls through to the site container.
- **TLS:** the site's own container router already triggers Let's Encrypt issuance for `<site>.<domain>`; `mcp-router` reuses that cert (Traefik dedups certs per SNI). No new cert plumbing.
- **Scope:** the regexp matches any first-level subdomain of the base domain, which is exactly the site-host space. The token in the path — not the host — is what authorizes; the router just delivers the request to the agent.
- **Fallback if per-host TLS proves fiddly:** also accept `api.<domain>/mcp/<token>` (already terminates at the agent, zero new routing). Keep the URL shape configurable so we can switch without touching the store or tools.

`updateDynamicConfig()` already rewrites this file on start; the router is static content, so no per-grant Traefik churn — grants never touch Traefik.

---

## 6. The MCP endpoint

### Transport
Streamable HTTP MCP (single `POST /mcp/<token>` accepting JSON-RPC, optional SSE for streaming). We implement the tiny slice of MCP we need directly on `Bun.serve` — `initialize`, `tools/list`, `tools/call` — rather than pulling a full SDK, matching the project's dependency-light style (it already hand-rolls its HTTP layer). Revisit adopting `@modelcontextprotocol/sdk` if the surface grows.

### Auth
`McpHandler` extracts `<token>` from the path, calls `GrantStore.resolveByToken`. Invalid/expired/revoked/exhausted → JSON-RPC error (and, before the MCP handshake, a fast `401` for a malformed token — guardrail: validate shape before doing any work). **This path bypasses `checkAuth` (the god key)** — it's the one authenticated-by-grant surface.

### Tools (all scoped to the grant's site + staging dir)

| Tool | Input | Behavior |
|------|-------|----------|
| `site_info` | — | Report the site's canonical public URL(s) (custom domain if set, else default subdomain) + current published version. |
| `list_files` | — | List staging files (relative paths). Seeds staging from current site code on first call. |
| `read_file` | `path` | Return file contents (text; base64 for binary). |
| `write_file` | `path`, `content` | Create/overwrite in staging. **Path hardening** (see §8). |
| `delete_file` | `path` | Remove from staging. |
| `deploy_site` | — | Merge + deploy (see §7). Consumes one deploy from the budget. Returns live URL + remaining deploys. |

Every tool result also carries a second content block — a compact context line
(`[editing site "x" · live at https://… · N deploy(s) left]`) — so a client that
drops `initialize` instructions still keeps the model aware of the site, its live
URL, and remaining budget. The primary tool output stays in the first block, so
`read_file` content is never polluted.

Tool descriptions tell the invitee's LLM the constraints ("web files only; backend is managed by the owner and cannot be changed here") so it doesn't try to touch schema.

### Session / staging lifecycle
- Staging is keyed by **grant id**, not MCP session — so a client reconnect resumes the same working copy until the grant dies.
- First file op seeds staging from the site's current `public/`.
- `deploy_site` does **not** delete staging (invitee may iterate if budget remains); `GrantStore.gc()` reclaims it once the grant is exhausted/expired/revoked.

---

## 7. Deploy path for grants (web-root-only merge)

The public `POST /sites/:name` expects a full zip (`public/` + `pb_migrations/` + `pb_hooks/`) and **replaces** all code. A grant must **not** let the invitee change backend dirs. So `deploy_site` uses a dedicated internal path, not the public route:

1. Read the site's **current** code from `SiteStorage.getCodePath(site)`.
2. Build the deploy file map:
   - `public/*`  ← from **staging** (invitee's edits)
   - `pb_migrations/*`, `pb_hooks/*` ← from **current site code** (untouched)
3. Zip it and call the same server-side deploy routine `handleDeploySite` uses — refactor its core into a reusable `deploySiteFromFiles(name, files, { deployedBy, force })`:
   - **Attribution:** `deployedBy = grant.label ?? "shared link"`.
   - **Concurrency (auto-rebase):** always deploy against the site's *current* version (no `expectedVersion` mismatch). Because staging seeds from current and backend is copied fresh from current at deploy time, the invitee's change rebases onto any owner change automatically. If the owner deployed *mid-session*, staging is stale → surface a friendly MCP error: *"The site changed since you started editing — re-run list_files to resync before deploying."* (Detect via a version stamp captured when staging was seeded vs. current version.)
4. On success: `GrantStore.recordDeploy(id)`; return `{ url, deploysRemaining }`.

This reuses versioning, history, container recreation, and TLS exactly as a normal deploy — the invitee's change is a first-class site version, rollback-able by the owner.

---

## 8. Security & guardrails (v1 scope)

**Path & size hardening (in `write_file`/staging):**
- Reject absolute paths, `..` segments, and anything resolving outside the staging dir (canonicalize + prefix-check).
- Cap per-file size and total staging size (reuse/adjacent to `config.maxUploadSize`).
- Validate token shape (`grt_` + expected length/charset) before any handshake work; malformed → `401`, no store hit.

**Auto-expiry & staging GC:**
- `expiresAt = min(owner-supplied, createdAt + HARD_MAX_TTL)` — every grant expires even if the owner sets none.
- `GrantStore.gc()` runs on agent start and after each grant resolution (cheap), deleting dead grants' JSON + staging dirs. Prevents disk leaks and zombie links.

**Blast-radius facts already guaranteed by design:** grant is site-scoped (id + hash → one site); backend dirs are never writable; god key never leaves the owner's machine; deploy budget + TTL bound abuse.

**Deferred (documented, not built):** per-grant rate limiting; explicit preview/confirm-before-publish + diff summary; OAuth connector front-end for claude.ai.

---

## 9. CLI surface

New command group `src/commands/sites/share.ts`, wired in `cli.ts`:

```sh
siteio sites share <name> [--deploys N] [--expires 24h] [--label "..."]   # create → prints MCP link
siteio sites share list <name>                                            # table of active grants
siteio sites share revoke <id>                                            # kill one grant
```

- Dual output per house style: JSON to stdout with `--json`, human-readable to stderr.
- `--expires` parses a duration (`30m`, `24h`, `7d`); validate against `HARD_MAX_TTL`.
- Create prints the full URL and a one-liner on how the invitee connects (paste into MCP client). Warn that the link is shown **once**.

New `SiteioClient` methods (`src/lib/client.ts`):

```ts
createGrant(site, { deploys?, expires?, label? }): Promise<{ grant: ShareGrant; url: string; token: string }>
listGrants(site): Promise<ShareGrant[]>
revokeGrant(id): Promise<void>
```

---

## 10. New agent routes (authed with the god key — owner side)

In `AgentServer.handleRequest`, under the existing `checkAuth` gate:

| Method & path | Handler | Notes |
|---|---|---|
| `POST /sites/:name/grants` | `handleCreateGrant` | Body `{ maxDeploys?, expiresAt?/expiresIn?, label? }`. Returns grant + raw token + assembled URL. |
| `GET /sites/:name/grants` | `handleListGrants` | Scrubs `tokenHash`; returns active (and optionally expired) grants. |
| `DELETE /sites/:name/grants/:id` | `handleRevokeGrant` | Sets `revoked`, GCs staging. |

The MCP endpoint itself is matched **before** `checkAuth` (like `/health` and `/ui`):

```
if (path.startsWith("/mcp/")) return this.mcp.handle(req, path)
```

---

## 11. File-by-file change list

**New**
- `src/lib/agent/grant-store.ts` — `GrantStore` (+ token gen/hash helpers, or reuse a new `utils/grant-token.ts`).
- `src/lib/agent/staging-store.ts` — `StagingStore` (seed from site code, path-safe read/write/delete, zip-for-deploy).
- `src/lib/agent/mcp.ts` — `McpHandler`: JSON-RPC parse, `initialize`/`tools/list`/`tools/call`, tool impls.
- `src/commands/sites/share.ts` — CLI group.

**Modified**
- `src/types.ts` — `ShareGrant`, grant DTOs, MCP tool I/O types.
- `src/lib/agent/server.ts` — construct `GrantStore`/`StagingStore`/`McpHandler`; pre-auth `/mcp/*` dispatch; `handleCreateGrant/List/Revoke`; refactor deploy core into `deploySiteFromFiles(...)` shared by `handleDeploySite` and the MCP deploy tool; run `GrantStore.gc()` in `start()`.
- `src/lib/agent/traefik.ts` — add `mcp-router` to `generateDynamicConfig()`.
- `src/lib/client.ts` — grant client methods.
- `src/cli.ts` — register `sites share` subcommands.
- `src/lib/skill-content.ts` — document the share flow for the owner's AI (mint a link) **and** note the invitee experience.

---

## 12. Testing plan (Bun, `skipTraefik: true`)

- **GrantStore unit:** create/hash/resolve; expiry, revoke, exhaustion boundaries; `gc()` removes dead grants + staging.
- **StagingStore unit:** seed from a fixture site; path-traversal + size caps rejected; zip merges staging `public/` with untouched backend dirs.
- **MCP handler (via `handleRequestForTest`-style seam):** unknown/expired/revoked token → error; `tools/list` returns the five tools; `write_file` → `deploy_site` produces a new site version with correct `deployedBy`; deploy decrements budget; over-budget deploy rejected; mid-session owner deploy → "re-sync" error.
- **Routing (unit on config gen):** `generateDynamicConfig()` emits `mcp-router` with `PathPrefix(/mcp)` and higher priority than container routers.
- **CLI:** `sites share` create/list/revoke output shapes (JSON + human).
- **E2E (real `AgentServer` on random port):** full loop — mint grant, drive MCP tools over HTTP, verify live site updated and backend untouched, second deploy blocked at `--deploys 1`.

---

## 13. Open questions / future

1. **claude.ai hosted connector** wants OAuth, not a token URL. The grant abstraction is OAuth-ready: a later authorization endpoint can treat a grant as a pre-authorized code without changing `GrantStore` or tools.
2. **Preview-before-publish**: add a `preview_url` (deploy to a throwaway `<site>-preview` host) + explicit `publish` step if owners want a review gate. Deferred.
3. **Rate limiting** per grant token — deferred; the deploy budget already bounds the expensive operation.
4. **Binary assets** over MCP: `read_file`/`write_file` use base64 for non-text; confirm client ergonomics for images.
5. **`HARD_MAX_TTL` value** — propose 7 days default cap; confirm.
```
