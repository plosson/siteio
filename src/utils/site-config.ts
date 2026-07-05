import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import type { SiteConfig } from "../types.ts"
import { ValidationError } from "./errors.ts"

const SITEIO_CONFIG_DIR = ".siteio"
const SITEIO_CONFIG_FILE = "config.json"

export function loadProjectConfig(dir: string = process.cwd()): SiteConfig | null {
  const configPath = join(dir, SITEIO_CONFIG_DIR, SITEIO_CONFIG_FILE)
  if (!existsSync(configPath)) return null
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as SiteConfig
    // `pocket` is the pre-merge key for what is now a site. Normalize on read;
    // the next save writes the canonical `site` key.
    if (config.pocket && !config.site) {
      config.site = config.pocket
      delete config.pocket
    }
    return config
  } catch {
    return null
  }
}

export function saveProjectConfig(config: SiteConfig, dir: string = process.cwd()): void {
  const configDir = join(dir, SITEIO_CONFIG_DIR)
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
  const { pocket: _legacy, ...canonical } = config
  writeFileSync(
    join(configDir, SITEIO_CONFIG_FILE),
    JSON.stringify(canonical, null, 2) + "\n"
  )
}

/**
 * Resolve site name from explicit argument or .siteio/config.json.
 * Returns null if neither source provides a value.
 */
export function resolveSiteName(explicit: string | undefined, serverDomain: string, dir?: string): string | null {
  if (explicit) return explicit
  const config = loadProjectConfig(dir)
  if (config) {
    if (config.app && !config.site) {
      throw new ValidationError(`This directory is configured as an app ('${config.app}'), not a site. Use 'siteio apps' commands instead.`)
    }
    if (config.site && config.domain === serverDomain) {
      return config.site
    }
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
  if (config) {
    if (config.site && !config.app) {
      throw new ValidationError(`This directory is configured as a site ('${config.site}'), not an app. Use 'siteio sites' commands instead.`)
    }
    if (config.app && config.domain === serverDomain) {
      return config.app
    }
  }
  return null
}
