// Central type definitions for siteio

// API Response types
export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

// OAuth settings for a site
export interface SiteOAuth {
  allowedEmails?: string[]
  allowedDomain?: string
  allowedGroups?: string[]
}

// Container restart policies
export type RestartPolicy = "always" | "unless-stopped" | "on-failure" | "no"

// Container status
export type ContainerStatus = "pending" | "running" | "stopped" | "failed"

// App types (static sites vs containers)
export type AppType = "static" | "container"

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
  credentialId?: string
}

// Inline Dockerfile source - file is uploaded by the client and built remotely
// in an empty context (Dockerfile must be self-contained, no COPY/ADD from context)
export interface DockerfileSource {
  source: "inline"
}

// Core App interface - unified model for sites and containers
export interface App {
  name: string
  type: AppType

  // Source
  image: string
  git?: GitSource
  dockerfile?: DockerfileSource

  // Runtime
  env: Record<string, string>
  volumes: VolumeMount[]
  internalPort: number
  restartPolicy: RestartPolicy

  // Routing
  domains: string[]

  // OAuth (same as current sites)
  oauth?: SiteOAuth

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
  image: string
  git?: GitSource
  dockerfile?: DockerfileSource
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

// Group of emails for access control
export interface Group {
  name: string
  emails: string[]
}

// TLS certificate status
export type TlsStatus = "valid" | "pending" | "error" | "none"

// Site information
export interface SiteInfo {
  subdomain: string
  url: string
  domains?: string[]
  size: number
  version?: number
  deployedAt: string
  oauth?: SiteOAuth
  persistentStorage?: boolean
  tls?: TlsStatus
}

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

// Deploy request payload
export interface DeployRequest {
  subdomain: string
}

// Internal site metadata stored by agent
export interface SiteMetadata {
  subdomain: string
  domains?: string[]
  size: number
  version?: number
  deployedAt: string
  deployedBy?: string
  files: string[]
  oauth?: SiteOAuth
  persistentStorage?: boolean
}

// Site config stored in .siteio/config.json (remembers site/app name and server)
export interface SiteConfig {
  site?: string   // for static sites
  app?: string    // for container apps
  domain: string
  version?: number // last deployed version (for optimistic concurrency)
}

// Site version info for history
export interface SiteVersion {
  version: number
  deployedAt: string
  deployedBy?: string
  size: number
}

// Command options
export interface DeployOptions {
  subdomain?: string
  allowedEmails?: string
  allowedDomain?: string
  test?: boolean
}

export interface AuthOptions {
  allowedEmails?: string
  allowedDomain?: string
  allowedGroups?: string
  addEmail?: string
  removeEmail?: string
  addDomain?: string
  removeDomain?: string
  addGroup?: string
  removeGroup?: string
  remove?: boolean
}

export interface LoginOptions {
  apiUrl?: string
  apiKey?: string
  token?: string
  domain?: string // Switch to existing server by domain
}

export interface AgentStartOptions {
  port?: number
}

// OAuth configuration for the agent (any OIDC provider)
export interface AgentOAuthConfig {
  issuerUrl: string
  clientId: string
  clientSecret: string
  cookieSecret: string
  cookieDomain: string
  /** Optional RP-initiated logout endpoint discovered from .well-known/openid-configuration. Absent for providers like Google that don't support OIDC end-session. */
  endSessionEndpoint?: string
}
