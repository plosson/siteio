// Library exports for siteio
// Pure functions, no side effects

export { SiteioClient } from "./lib/client.ts"
export { AgentServer } from "./lib/agent/server.ts"
export { SiteStorage } from "./lib/agent/storage.ts"
export { TraefikManager } from "./lib/agent/traefik.ts"

export type {
  ApiResponse,
  SiteInfo,
  ClientConfig,
  AgentConfig,
  SiteMetadata,
  DeployRequest,
  DeployOptions,
  LoginOptions,
  AgentStartOptions,
} from "./types.ts"
