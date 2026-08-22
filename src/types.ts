// Central type definitions for siteio

// API Response types
export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

// Container restart policies
export type RestartPolicy = "always" | "unless-stopped" | "on-failure" | "no"

// Container status
export type ContainerStatus = "pending" | "running" | "stopped" | "failed"

// App types
export type AppType = "container"

// Volume mount configuration
export interface VolumeMount {
  name: string // Host path or named volume
  mountPath: string // Container path
  readonly?: boolean // Optional read-only flag
}

// Git source configuration for building from repo
export interface GitSource {
  repoUrl: string
  branch: string
  dockerfile: string
  context?: string // Subdirectory for monorepo support
  token?: string // Optional PAT for private HTTPS repos; injected via GIT_ASKPASS at clone time
  // Set by the server on outgoing API responses — true when a token is stored.
  // Never sent by clients; the server ignores it on PATCH.
  tokenSet?: boolean
}

// Inline Dockerfile source - file is uploaded by the client and built remotely
// in an empty context (Dockerfile must be self-contained, no COPY/ADD from context)
export interface DockerfileSource {
  source: "inline"
}

/**
 * Compose source — user supplied a docker-compose.yml instead of a single
 * Dockerfile/image. Exactly one service in the file is publicly exposed
 * through Traefik; dependencies run alongside it on the compose project network.
 *
 * Exclusivity invariant (enforced in the API layer by handleCreateApp):
 *   - mutually exclusive with `dockerfile` and `image`
 *   - the `git` variant requires `App.git` to also be set; `path` is the
 *     compose file's location within the cloned repo
 */
export type ComposeSource =
  | { source: "inline"; primaryService: string }
  | { source: "git"; path: string; primaryService: string }

// Core App interface - unified model for sites and containers
export interface App {
  name: string
  type: AppType

  // Source
  image: string
  git?: GitSource
  dockerfile?: DockerfileSource
  compose?: ComposeSource

  // Runtime
  env: Record<string, string>
  volumes: VolumeMount[]
  internalPort: number
  restartPolicy: RestartPolicy

  // Routing
  domains: string[]

  // State
  containerId?: string
  status: ContainerStatus
  deployedAt?: string
  createdAt: string
  updatedAt: string

  // Git build state
  commitHash?: string
  lastBuildAt?: string
}

// App info returned to clients (subset of App)
export interface AppInfo {
  name: string
  type: AppType
  url: string
  image: string
  git?: GitSource
  dockerfile?: DockerfileSource
  compose?: ComposeSource
  status: ContainerStatus
  domains: string[]
  internalPort: number
  deployedAt?: string
  createdAt: string
  commitHash?: string
  lastBuildAt?: string
  tls?: TlsStatus
  // Whether a generated card preview exists (fetched via
  // GET /apps/:name/thumbnail). Only single-container apps get one.
  hasThumbnail?: boolean
}

// Container logs response
export interface ContainerLogs {
  name: string
  logs: string
  lines: number
}

// Container inspection result
export interface ContainerInspect {
  id: string
  name: string
  state: {
    running: boolean
    status: string
    startedAt?: string
    exitCode?: number
  }
  image: string
  ports: Record<string, string>
}

// TLS certificate status
export type TlsStatus = "valid" | "pending" | "error" | "none"

// Single server config
export interface ServerConfig {
  apiUrl: string
  apiKey: string
}

// Config stored in ~/.config/siteio/config.json
export interface ClientConfig {
  // Current active server domain
  current?: string
  // All stored servers keyed by domain
  servers?: Record<string, ServerConfig>
  // Username for deploy attribution
  username?: string
  // Legacy fields for backward compatibility (will be migrated)
  apiUrl?: string
  apiKey?: string
}

// ACME challenge types supported by Traefik
export type AcmeChallengeType = "http" | "tls" | "dns"

// ACME certificate configuration
export interface AcmeConfig {
  challenge: AcmeChallengeType
  dnsProvider?: string // Traefik DNS provider name (e.g. "route53", "cloudflare")
  dnsEnv?: Record<string, string> // Provider-specific env vars passed to Traefik container
}

// Agent configuration (from env vars)
export interface AgentConfig {
  apiKey: string
  dataDir: string
  domain: string
  maxUploadSize: number
  httpPort: number
  httpsPort: number
  email?: string // For Let's Encrypt
  acme?: AcmeConfig // ACME challenge configuration
  skipTraefik?: boolean // For testing without Traefik
  port?: number // Override internal API port
  appsEnabled?: boolean // Whether the /apps/* surface is available (default true)
  chat?: ChatConfig // AI site-chat editor settings; absent/unconfigured hides the feature
}

// AI site-chat editor configuration (see docs/plans/2026-08-20-site-chat-ai-editor.md).
// Assembled from SITEIO_LLM_*/SITEIO_CHAT_* env + persisted config in start.ts.
// `provider` is the LLM provider (only "anthropic" is implemented in v1). A turn
// runs a full coding agent over a throwaway copy of the site's source and
// redeploys. The credential is a Claude subscription OAuth token (preferred) or
// an Anthropic API key; the feature is considered configured iff one is present.
export interface ChatConfig {
  provider: string // "anthropic"
  model?: string // optional model override, e.g. "claude-sonnet-5"
  oauthToken?: string // CLAUDE_CODE_OAUTH_TOKEN (Claude subscription) — preferred
  apiKey?: string // ANTHROPIC_API_KEY — alternative to a subscription token
  sandbox: boolean // run the agent inside a throwaway container (v1 default on)
  sandboxImage: string // image containing the `claude` CLI + node
  sandboxNetwork: string // docker network the sandbox joins (operator locks egress)
  maxTurns: number // agent tool-use iteration cap
  timeoutMs: number // per-turn wall-clock cap (kept < 255s for SSE idle safety)
}

// Whether the chat editor is usable, surfaced to the UI so it can hide the tab.
export interface ChatConfigStatus {
  configured: boolean
  provider?: string
  model?: string
  sandbox?: boolean
}

// Site config stored in .siteio/config.json (remembers site/app name and server)
export interface SiteConfig {
  site?: string   // for sites
  app?: string    // for container apps
  pocket?: string // legacy alias for `site` — read but never written
  domain: string
  version?: number // last deployed version (for optimistic concurrency)
  pocketbaseVersion?: string // pinned PocketBase version for this project
}

// Site: a PocketBase-backed site — static frontend plus optional backend
// (auth, database, file storage). Stored server-side, one container per site.
// Code is mounted read-only; pb_data lives on a persistent volume and is
// never rolled back.
export interface Site {
  name: string
  // Custom domains only; the default `<name>.<domain>` subdomain is derived.
  domains: string[]
  pocketbaseVersion: string
  status: ContainerStatus
  containerId?: string
  size: number
  version?: number
  deployedAt?: string
  deployedBy?: string
  // Change description for the current version. Required for MCP share deploys;
  // absent for owner/CLI deploys that don't supply one.
  message?: string
  createdAt: string
  updatedAt: string
  // Auto-generated on first deploy; surfaced via `siteio sites admin`.
  superuserEmail?: string
  superuserPassword?: string
}

// Site info returned to clients (secrets stripped).
export interface SiteInfo {
  name: string
  url: string
  adminUrl: string
  domains: string[]
  status: ContainerStatus
  pocketbaseVersion: string
  size: number
  version?: number
  deployedAt?: string
  createdAt: string
  tls?: TlsStatus
  // Whether a generated card preview exists (fetched separately via
  // GET /sites/:name/thumbnail). Absent/false means show the placeholder.
  hasThumbnail?: boolean
  // Whether the AI chat editor is available for this agent (drives tab visibility
  // on the site detail page). Full status/history comes from GET /sites/:name/chat.
  chatEnabled?: boolean
}

// Site version info for history
export interface SiteVersion {
  version: number
  deployedAt: string
  deployedBy?: string
  // Change description captured for this version at deploy time (see Site.message).
  message?: string
  size: number
}

// --- AI site-chat editor ---

export type ChatRole = "user" | "assistant"

// The outcome of an assistant turn. "ok" deployed a change; "no_changes" ran the
// agent but nothing changed (a question, or a no-op edit) so nothing deployed;
// "error" means the agent or the deploy failed.
export type ChatTurnStatus = "ok" | "no_changes" | "error"

// A summarized tool invocation shown in the transcript (not the raw tool I/O).
export interface ChatToolCall {
  name: string
  detail?: string
}

// One persisted message in a site's chat transcript.
export interface ChatMessage {
  id: string
  role: ChatRole
  text: string
  at: string // ISO timestamp
  // Assistant-turn metadata (absent on user messages):
  status?: ChatTurnStatus
  toolCalls?: ChatToolCall[]
  changedFiles?: string[]
  // Version bookkeeping so the UI can offer a one-click revert of this turn:
  versionBefore?: number
  versionAfter?: number
  deployed?: boolean
  error?: string
}

// Server→client streamed events during a turn (SSE). Terminal events are
// "done" (carrying the persisted assistant message) and "error".
export type ChatEvent =
  | { kind: "assistant_text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; name: string; detail?: string }
  | { kind: "tool_result"; ok: boolean; detail?: string }
  | { kind: "deploy_progress"; message: string }
  | { kind: "done"; message: ChatMessage }
  | { kind: "error"; message: string }
  | { kind: "heartbeat" }

// The flavor of a grant. "share" (default when `kind` is absent) is the classic
// MCP/CLI content-deploy link, valid until revoked. "edit" and "edit-session"
// back the in-site live editor (docs/plans/2026-08-21-in-site-chat-widget.md):
//   - "edit"         — a one-time, TTL'd *code* carried in the editor-shell URL
//                      fragment; exchanged (on an explicit gesture) for a session.
//   - "edit-session" — a derived, cookie-borne session grant scoped to /_siteio;
//                      linked to its parent "edit" code so revoke cascades.
// Only edit-kind grants may reach the scoped chat routes; classic shares can't.
export type GrantKind = "share" | "edit" | "edit-session"

// A share grant: authorizes an invitee to edit and redeploy ONE site. A classic
// share stays valid until the owner revokes it; edit-kind grants also carry a
// TTL and a per-grant spend cap. The raw token is shown/returned exactly once
// (on creation); only its hash is persisted.
export interface ShareGrant {
  id: string // short public id (e.g. "grt_ab12cd") — used in `share list/revoke`
  site: string // site this grant is scoped to
  tokenHash: string // sha-256 hex of the raw token; the raw token is never stored
  label?: string // optional; surfaced as the deploy author (X-Deployed-By)
  // When true (owner opt-in via `share --allow-backend`), a scoped deploy may
  // also change the site's backend (pb_migrations, pb_hooks). Default false:
  // backend is preserved and the invitee is confined to the web root. Edit-kind
  // grants force this false.
  allowBackend?: boolean
  createdAt: string
  lastUsedAt?: string
  revoked: boolean
  // --- edit-link fields (absent on classic shares) ---
  kind?: GrantKind // absent ⇒ "share"
  expiresAt?: string // ISO; once past, the grant no longer resolves (live TTL)
  consumedAt?: string // ISO; when an "edit" code was first exchanged for a session
  parentId?: string // "edit-session" → the "edit" code it derives from
  versionAtStart?: number // site version when the edit link was minted (restore-to-start)
  // Per-grant turn cap (edit kinds): `turns` bumps each chat turn, refused past `maxTurns`.
  turns?: number
  maxTurns?: number
}

// Grant returned to the owner over the API — the tokenHash is stripped.
export interface ShareGrantInfo {
  id: string
  site: string
  label?: string
  allowBackend?: boolean
  createdAt: string
  lastUsedAt?: string
  revoked: boolean
  active: boolean // computed: not revoked and not expired
  kind?: GrantKind
  expiresAt?: string
  consumedAt?: string
  versionAtStart?: number
}

// Response to grant creation. The connector URL is the same for every grant on
// a site; the per-invitee secret is the `code`, entered on the OAuth consent
// page. The code is shown only once.
export interface ShareGrantCreated {
  grant: ShareGrantInfo
  url: string // primary MCP connector URL — the site's custom domain if it has one, else <site>.<domain>
  code: string // one-time share code the invitee enters to authorize (also the CLI key)
  cliToken: string // `siteio login -t <cliToken>` for the CLI tier (points at the same primary host)
  fallbackUrl?: string // the platform subdomain connector URL, when `url` is a custom domain
}

// Response to `sites edit` — mints a one-time, TTL'd editor-shell link. The code
// rides the URL fragment (server-invisible) and is exchanged, on an explicit
// gesture, for a cookie session. The URL always targets the *platform*
// subdomain (never a custom/CDN-fronted domain) so edge cache can't hide fresh
// deploys. Shown once.
export interface EditLinkCreated {
  grant: ShareGrantInfo
  url: string // https://<name>.<domain>/_siteio/edit#<code>
  code: string // the one-time edit code (also embedded in `url`'s fragment)
  expiresAt: string // ISO; when the code stops working
}

export interface LoginOptions {
  apiUrl?: string
  apiKey?: string
  token?: string
  username?: string
  domain?: string // Switch to existing server by domain
}

export interface AgentStartOptions {
  port?: number
}
