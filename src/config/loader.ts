import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { homedir } from "os"
import { join, dirname } from "path"
import type { ClientConfig } from "../types.ts"

const CONFIG_DIR = join(homedir(), ".config", "siteio")
const CONFIG_FILE = join(CONFIG_DIR, "config.json")

const DEFAULTS: ClientConfig = {}

export function loadConfig(): ClientConfig {
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

export function saveConfig(config: ClientConfig): void {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true })
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
  } catch {
    // Silently fail - config is optional
  }
}

export function getConfigPath(): string {
  return CONFIG_FILE
}

export function isConfigured(): boolean {
  const config = loadConfig()
  return !!(config.apiUrl && config.apiKey)
}
