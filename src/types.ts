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
}

// Site version info for history
export interface SiteVersion {
  version: number
  deployedAt: string
  deployedBy?: string
  size: number
}

// A single-use (by default) share grant: authorizes an anonymous invitee to
// edit and redeploy ONE site's web root via an MCP link, bounded by a deploy
// budget and a hard expiry. The raw token is shown to the owner exactly once
// (on creation); only its hash is persisted.
export interface ShareGrant {
  id: string // short public id (e.g. "grt_ab12cd") — used in `share list/revoke`
  site: string // site this grant is scoped to
  tokenHash: string // sha-256 hex of the raw token; the raw token is never stored
  label?: string // optional; surfaced as the deploy author (X-Deployed-By)
  maxDeploys: number // owner-set budget; default 1
  deploysUsed: number
  createdAt: string
  expiresAt: string // owner-set OR createdAt + hard max TTL, whichever is sooner
  lastUsedAt?: string
  revoked: boolean
}

// Grant returned to the owner over the API — the tokenHash is stripped.
export interface ShareGrantInfo {
  id: string
  site: string
  label?: string
  maxDeploys: number
  deploysUsed: number
  createdAt: string
  expiresAt: string
  lastUsedAt?: string
  revoked: boolean
  active: boolean // computed: not revoked, not expired, budget remaining
}

// Response to grant creation — carries the one-time token and the MCP link.
export interface ShareGrantCreated {
  grant: ShareGrantInfo
  token: string // raw token, shown once
  url: string // full MCP link: https://<site>.<domain>/mcp/<token>
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
