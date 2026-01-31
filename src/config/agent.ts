/**
 * Agent configuration management
 *
 * Handles persistent configuration stored in <dataDir>/agent-config.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"

export interface PersistedAgentConfig {
  apiKey: string
  domain?: string
  cloudflareToken?: string
}

const CONFIG_FILENAME = "agent-config.json"

/**
 * Get the path to the agent config file
 */
export function getAgentConfigPath(dataDir: string): string {
  return join(dataDir, CONFIG_FILENAME)
}

/**
 * Load agent config from disk
 */
export function loadAgentConfig(dataDir: string): Partial<PersistedAgentConfig> {
  const configPath = getAgentConfigPath(dataDir)

  if (!existsSync(configPath)) {
    return {}
  }

  try {
    return JSON.parse(readFileSync(configPath, "utf-8"))
  } catch {
    return {}
  }
}

/**
 * Save agent config to disk
 */
export function saveAgentConfig(dataDir: string, config: PersistedAgentConfig): void {
  const configPath = getAgentConfigPath(dataDir)
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2))
}

/**
 * Update specific fields in agent config (merge with existing)
 */
export function updateAgentConfig(
  dataDir: string,
  updates: Partial<PersistedAgentConfig>
): PersistedAgentConfig {
  const existing = loadAgentConfig(dataDir)
  const updated = { ...existing, ...updates } as PersistedAgentConfig

  // Remove undefined values
  for (const key of Object.keys(updated) as (keyof PersistedAgentConfig)[]) {
    if (updated[key] === undefined) {
      delete updated[key]
    }
  }

  saveAgentConfig(dataDir, updated)
  return updated
}

/**
 * Get a specific config value
 */
export function getAgentConfigValue(
  dataDir: string,
  key: keyof PersistedAgentConfig
): string | undefined {
  const config = loadAgentConfig(dataDir)
  return config[key]
}

/**
 * Set a specific config value
 */
export function setAgentConfigValue(
  dataDir: string,
  key: keyof PersistedAgentConfig,
  value: string
): void {
  updateAgentConfig(dataDir, { [key]: value })
}

/**
 * Delete a specific config value
 */
export function deleteAgentConfigValue(
  dataDir: string,
  key: keyof PersistedAgentConfig
): void {
  const config = loadAgentConfig(dataDir)
  delete config[key]
  saveAgentConfig(dataDir, config as PersistedAgentConfig)
}

/**
 * Mask sensitive values for display (show last 4 chars)
 */
export function maskSensitiveValue(value: string): string {
  if (value.length <= 8) {
    return "****"
  }
  return "****" + value.slice(-4)
}

/**
 * Check if a key contains sensitive data
 */
export function isSensitiveKey(key: string): boolean {
  const sensitiveKeys = ["apiKey", "cloudflareToken"]
  return sensitiveKeys.includes(key)
}
