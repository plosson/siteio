import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import type { AgentOAuthConfig } from "../types.ts"

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
