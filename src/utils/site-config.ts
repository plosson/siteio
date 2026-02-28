import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import type { SiteConfig } from "../types.ts"

const SITEIO_CONFIG_DIR = ".siteio"
const SITEIO_CONFIG_FILE = "config.json"

export function loadProjectConfig(dir: string = process.cwd()): SiteConfig | null {
  const configPath = join(dir, SITEIO_CONFIG_DIR, SITEIO_CONFIG_FILE)
  if (!existsSync(configPath)) return null
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"))
  } catch {
    return null
  }
}

export function saveProjectConfig(config: SiteConfig, dir: string = process.cwd()): void {
  const configDir = join(dir, SITEIO_CONFIG_DIR)
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, SITEIO_CONFIG_FILE),
    JSON.stringify(config, null, 2) + "\n"
  )
}

/**
 * Resolve subdomain from explicit argument or .siteio/config.json.
 * Returns null if neither source provides a value.
 */
export function resolveSubdomain(explicit: string | undefined, serverDomain: string, dir?: string): string | null {
  if (explicit) return explicit
  const config = loadProjectConfig(dir)
  if (config && config.site && config.domain === serverDomain) {
    return config.site
  }
  return null
}

/**
 * Resolve app name from explicit argument or .siteio/config.json.
 * Returns null if neither source provides a value.
 */
export function resolveAppName(explicit: string | undefined, serverDomain: string, dir?: string): string | null {
  if (explicit) return explicit
  const config = loadProjectConfig(dir)
  if (config && config.app && config.domain === serverDomain) {
    return config.app
  }
  return null
}
