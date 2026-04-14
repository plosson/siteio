import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import type { AgentOAuthConfig } from "../types.ts"
import { discoverOIDC } from "./oidc-discovery.ts"

const OAUTH_CONFIG_FILE = "oauth-config.json"

export function loadOAuthConfig(dataDir: string): AgentOAuthConfig | null {
  const configPath = join(dataDir, OAUTH_CONFIG_FILE)

  if (!existsSync(configPath)) {
    return null
  }

  try {
    const content = readFileSync(configPath, "utf-8")
    const config = JSON.parse(content) as AgentOAuthConfig

    // Validate required fields
    if (
      !config.issuerUrl ||
      !config.clientId ||
      !config.clientSecret ||
      !config.cookieSecret ||
      !config.cookieDomain
    ) {
      return null
    }

    return config
  } catch {
    return null
  }
}

export function saveOAuthConfig(dataDir: string, config: AgentOAuthConfig): void {
  const configPath = join(dataDir, OAUTH_CONFIG_FILE)

  // Ensure directory exists
  const dir = dirname(configPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2))
}

/**
 * Check if OAuth is fully configured (all required fields present).
 * Returns true only if config exists and has: issuerUrl, clientId, clientSecret, cookieSecret, cookieDomain.
 */
export function isOAuthConfigured(dataDir: string): boolean {
  return loadOAuthConfig(dataDir) !== null
}

/**
 * Load the agent OAuth config, running OIDC discovery once for legacy configs
 * (those without a `discoveredAt` timestamp) and persisting the result.
 *
 * Only the agent-start path should use this — CLI commands that simply read
 * the config should keep using the sync `loadOAuthConfig`.
 */
export async function ensureDiscoveredConfig(dataDir: string): Promise<AgentOAuthConfig | null> {
  const config = loadOAuthConfig(dataDir)
  if (!config) return null
  if (config.discoveredAt) return config

  try {
    const discovered = await discoverOIDC(config.issuerUrl)
    const updated: AgentOAuthConfig = {
      ...config,
      issuerUrl: discovered.issuer,
      endSessionEndpoint: discovered.endSessionEndpoint,
      discoveredAt: new Date().toISOString(),
    }
    saveOAuthConfig(dataDir, updated)
    return updated
  } catch (err) {
    // Discovery failure is non-fatal — keep legacy behavior.
    console.warn(`> OIDC discovery failed, using config as-is: ${err instanceof Error ? err.message : err}`)
    return config
  }
}
