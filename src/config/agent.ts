/**
 * Agent configuration management
 *
 * Handles persistent configuration stored in <dataDir>/agent-config.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"

import type { AcmeChallengeType } from "../types.ts"

export interface PersistedAgentConfig {
  apiKey: string
  domain?: string
  cloudflareToken?: string
  acmeChallenge?: AcmeChallengeType
  acmeDnsProvider?: string
  acmeDnsEnv?: Record<string, string>
  appsEnabled?: boolean
  // AI site-chat editor. `llmOauthToken` is a Claude subscription token
  // (preferred); `llmApiKey` is an Anthropic API key alternative. Either enables
  // the feature. See docs/plans/2026-08-20-site-chat-ai-editor.md.
  llmProvider?: string
  llmModel?: string
  llmOauthToken?: string
  llmApiKey?: string
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
  // 0600: this file holds the god API key, Cloudflare/DNS creds, and (now) the
  // LLM credential. World-readable (the historical default) would let any local
  // process — including a chat agent — read every secret.
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 })
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
): PersistedAgentConfig[keyof PersistedAgentConfig] {
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
  updateAgentConfig(dataDir, { [key]: value } as Partial<PersistedAgentConfig>)
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
  const sensitiveKeys = ["apiKey", "cloudflareToken", "acmeDnsEnv", "llmOauthToken", "llmApiKey"]
  return sensitiveKeys.includes(key)
}
