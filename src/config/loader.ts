import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { ClientConfig, ServerConfig } from "../types.ts"

export const CONFIG_DIR = join(homedir(), ".config", "siteio")
const CONFIG_FILE = join(CONFIG_DIR, "config.json")

const DEFAULTS: ClientConfig = {}

/**
 * Load raw config file (internal use)
 */
export function loadRawConfig(): ClientConfig {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return DEFAULTS
    }
    const data = readFileSync(CONFIG_FILE, "utf-8")
    return { ...DEFAULTS, ...JSON.parse(data) }
  } catch {
    return DEFAULTS
  }
}

/**
 * Migrate legacy config (apiUrl/apiKey at root) to new format
 */
function migrateConfig(config: ClientConfig): ClientConfig {
  // Already migrated or empty
  if (config.servers || (!config.apiUrl && !config.apiKey)) {
    return config
  }

  // Migrate legacy format
  if (config.apiUrl && config.apiKey) {
    const domain = extractDomain(config.apiUrl)
    return {
      ...config,
      current: domain,
      servers: {
        [domain]: {
          apiUrl: config.apiUrl,
          apiKey: config.apiKey,
        },
      },
    }
  }

  return config
}

/**
 * Extract domain from API URL (e.g., "https://api.example.com" -> "example.com")
 */
export function extractDomain(apiUrl: string): string {
  try {
    const url = new URL(apiUrl)
    // Remove "api." prefix if present
    return url.hostname.replace(/^api\./, "")
  } catch {
    return apiUrl
  }
}

/**
 * Load config and return current server's config for backward compatibility
 */
export function loadConfig(): ClientConfig {
  const raw = loadRawConfig()
  const config = migrateConfig(raw)

  // Return current server config at root level for backward compat
  if (config.current && config.servers) {
    const server = config.servers[config.current]
    if (server) {
      return {
        ...config,
        apiUrl: server.apiUrl,
        apiKey: server.apiKey,
      }
    }
  }

  return config
}

/**
 * Save config to file
 */
export function saveConfig(config: ClientConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  const { apiUrl: _url, apiKey: _key, ...toSave } = migrateConfig(config)
  const temporary = `${CONFIG_FILE}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(toSave, null, 2), { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, CONFIG_FILE)
}

/**
 * Add or update a server in config and set it as current
 */
export function addServer(apiUrl: string, apiKey: string): string {
  const config = migrateConfig(loadRawConfig())
  const domain = extractDomain(apiUrl)

  const servers = config.servers || {}
  servers[domain] = { apiUrl, apiKey }

  saveConfig({
    ...config,
    current: domain,
    servers,
  })

  return domain
}

/**
 * Switch to an existing server by domain
 */
export function switchServer(domain: string): ServerConfig | null {
  const config = migrateConfig(loadRawConfig())

  if (!config.servers?.[domain]) {
    return null
  }

  saveConfig({
    ...config,
    current: domain,
  })

  return config.servers[domain]
}

/**
 * Get list of all stored servers
 */
export function listServers(): { domain: string; current: boolean }[] {
  const config = migrateConfig(loadRawConfig())

  if (!config.servers) {
    return []
  }

  return Object.keys(config.servers).map((domain) => ({
    domain,
    current: domain === config.current,
  }))
}

/**
 * Remove a server from config
 */
export function removeServer(domain: string): boolean {
  const config = migrateConfig(loadRawConfig())

  if (!config.servers?.[domain]) {
    return false
  }

  delete config.servers[domain]

  // If we removed the current server, switch to another or clear
  let newCurrent = config.current
  if (config.current === domain) {
    const remaining = Object.keys(config.servers)
    newCurrent = remaining.length > 0 ? remaining[0] : undefined
  }

  saveConfig({
    ...config,
    current: newCurrent,
    servers: config.servers,
  })

  return true
}

/**
 * Get current server config
 */
export function getCurrentServer(): (ServerConfig & { domain: string }) | null {
  const config = migrateConfig(loadRawConfig())

  if (!config.current || !config.servers) {
    return null
  }

  const server = config.servers[config.current]
  if (!server) {
    return null
  }

  return {
    domain: config.current,
    ...server,
  }
}

export function getConfigPath(): string {
  return CONFIG_FILE
}

export function isConfigured(): boolean {
  return getCurrentServer() !== null
}

export function getUsername(): string | undefined {
  const config = loadRawConfig()
  return config.username
}

export function setUsername(username: string): void {
  const config = migrateConfig(loadRawConfig())
  config.username = username
  saveConfig(config)
}

export type ProviderTokenKey = "hetznerToken" | "cloudflareToken"

export function getProviderToken(key: ProviderTokenKey): string | undefined {
  const env = key === "hetznerToken"
    ? process.env.HETZNER_TOKEN || process.env.HCLOUD_TOKEN
    : process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_TOKEN
  return env || loadRawConfig()[key]
}

export function setProviderToken(key: ProviderTokenKey, value: string): void {
  saveConfig({ ...loadRawConfig(), [key]: value })
}
