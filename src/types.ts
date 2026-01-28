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
