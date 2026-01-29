// Library exports for siteio
// Pure functions, no side effects

export { SiteioClient } from "./lib/client.ts"
export { AgentServer } from "./lib/agent/server.ts"
export { SiteStorage } from "./lib/agent/storage.ts"
export { TraefikManager } from "./lib/agent/traefik.ts"
export { AppStorage } from "./lib/agent/app-storage"
export { DockerManager } from "./lib/agent/docker"
export { encodeToken, decodeToken, isValidToken } from "./utils/token.ts"
export { loadOAuthConfig, saveOAuthConfig } from "./config/oauth.ts"

export type {
  ApiResponse,
  SiteInfo,
  SiteOAuth,
  ClientConfig,
  AgentConfig,
  AgentOAuthConfig,
  SiteMetadata,
  DeployRequest,
  DeployOptions,
  AuthOptions,
  LoginOptions,
  AgentStartOptions,
} from "./types.ts"

export type { TokenData } from "./utils/token.ts"
export type { ContainerRunConfig } from "./lib/agent/docker"
