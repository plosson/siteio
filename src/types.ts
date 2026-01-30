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

// Core App interface - unified model for sites and containers
export interface App {
  name: string
  type: AppType

  // Source
  image: string
  git?: GitSource

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
  status: ContainerStatus
  domains: string[]
  internalPort: number
  deployedAt?: string
  createdAt: string
  commitHash?: string
  lastBuildAt?: string
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

// Site information
export interface SiteInfo {
  subdomain: string
  url: string
  size: number
  deployedAt: string
  oauth?: SiteOAuth
}

// Config stored in ~/.config/siteio/config.json
export interface ClientConfig {
  apiUrl?: string
  apiKey?: string
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
  size: number
  deployedAt: string
  files: string[]
  oauth?: SiteOAuth
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
}

export interface AgentStartOptions {
  port?: number
}

// OAuth configuration for the agent (OIDC provider like Auth0, Clerk, etc.)
export interface AgentOAuthConfig {
  issuerUrl: string
  clientId: string
  clientSecret: string
  cookieSecret: string
  cookieDomain: string
}
