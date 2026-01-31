import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { ClientConfig, ServerConfig } from "../types.ts"

const CONFIG_DIR = join(homedir(), ".config", "siteio")
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
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true })
    }
    // Only save the new format fields
    const toSave: ClientConfig = {
      current: config.current,
      servers: config.servers,
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(toSave, null, 2))
  } catch {
    // Silently fail - config is optional
  }
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
