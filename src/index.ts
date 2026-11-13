// Library exports for siteio
// Pure functions, no side effects

export { AppStorage } from "./lib/agent/app-storage.ts"
export type { ContainerRunConfig } from "./lib/agent/docker.ts"
export { DockerManager } from "./lib/agent/docker.ts"
export { AgentServer } from "./lib/agent/server.ts"
export { SiteStorage } from "./lib/agent/storage.ts"
export { TraefikManager } from "./lib/agent/traefik.ts"
export { SiteioClient } from "./lib/client.ts"

export type {
  AgentConfig,
  AgentStartOptions,
  ApiResponse,
  App,
  AppInfo,
  AppType,
  ClientConfig,
  ContainerLogs,
  ContainerStatus,
  LoginOptions,
  RestartPolicy,
  Site,
  SiteInfo,
  SiteVersion,
  VolumeMount,
} from "./types.ts"

export type { TokenData } from "./utils/token.ts"
export { decodeToken, encodeToken, isValidToken } from "./utils/token.ts"
