import { existsSync, mkdirSync, readdirSync, readFileSync, cpSync, renameSync } from "fs"
import { join } from "path"
import type { SiteStorage } from "./storage.ts"
import { POCKETBASE_VERSION } from "../pocketbase-version.ts"

// Metadata shape written by pre-merge agents for shared-nginx static sites.
// The type lives here because everything else about that implementation is gone.
interface LegacySiteMetadata {
  subdomain: string
  domains?: string[]
  size: number
  version?: number
  deployedAt: string
  deployedBy?: string
  oauth?: unknown
  persistentStorage?: boolean
}

export interface LegacyMigrationOutcome {
  migrated: string[]
  skipped: { name: string; reason: string }[]
}

const LEGACY_DIRS = ["sites", "metadata", "history", "persistent-storage", "nginx"]

export function hasLegacySites(dataDir: string): boolean {
  const metaDir = join(dataDir, "metadata")
  return existsSync(metaDir) && readdirSync(metaDir).some((f) => f.endsWith(".json"))
}

/**
 * Convert pre-merge shared-nginx static sites into the current per-container
 * model. File-level only — the caller starts the containers.
 *
 * Never deletes anything: site files and history are COPIED into the new
 * layout, then the legacy directories are moved wholesale into
 * <dataDir>/legacy-backup/ for manual cleanup once the migration is verified.
 * Idempotent by construction: once metadata/ is moved away, hasLegacySites()
 * is false and this never runs again.
 */
export function migrateLegacySites(
  dataDir: string,
  domain: string,
  storage: SiteStorage,
  log: (msg: string) => void = console.log
): LegacyMigrationOutcome {
  const metaDir = join(dataDir, "metadata")
  const outcome: LegacyMigrationOutcome = { migrated: [], skipped: [] }

  for (const file of readdirSync(metaDir).filter((f) => f.endsWith(".json"))) {
    let name = file.slice(0, -5)
    try {
      const legacy = JSON.parse(readFileSync(join(metaDir, file), "utf-8")) as LegacySiteMetadata
      name = legacy.subdomain || name

      if (storage.exists(name)) {
        outcome.skipped.push({ name, reason: "a site with this name already exists — legacy files kept in legacy-backup/" })
        continue
      }

      const filesDir = join(dataDir, "sites", name)
      if (!existsSync(filesDir)) {
        outcome.skipped.push({ name, reason: "metadata found but no site files — legacy files kept in legacy-backup/" })
        continue
      }

      storage.create({
        name,
        domains: legacy.domains ?? [],
        pocketbaseVersion: POCKETBASE_VERSION,
        status: "pending",
        size: legacy.size ?? 0,
        version: legacy.version,
        deployedAt: legacy.deployedAt,
        deployedBy: legacy.deployedBy,
        superuserEmail: `admin@${name}.${domain}`,
        superuserPassword: crypto.randomUUID().replace(/-/g, ""),
      })

      // Site files become the web root of the new code layout.
      const codePath = storage.getCodePath(name)
      cpSync(filesDir, join(codePath, "public"), { recursive: true })
      for (const sub of ["pb_migrations", "pb_hooks"]) {
        mkdirSync(join(codePath, sub), { recursive: true, mode: 0o755 })
      }

      // Carry version history over, wrapping each archived version the same way.
      const legacyHistory = join(dataDir, "history", name)
      if (existsSync(legacyHistory)) {
        const newHistory = join(dataDir, "pocket-history", name)
        mkdirSync(newHistory, { recursive: true, mode: 0o755 })
        for (const entry of readdirSync(legacyHistory)) {
          const from = join(legacyHistory, entry)
          if (entry.endsWith(".json")) {
            cpSync(from, join(newHistory, entry))
          } else if (/^v\d+$/.test(entry)) {
            cpSync(from, join(newHistory, entry, "public"), { recursive: true })
          }
        }
      }

      if (legacy.oauth) {
        log(`> Site '${name}': OAuth protection was dropped (no longer supported)`)
      }
      if (legacy.persistentStorage) {
        log(`> Site '${name}': persistent-localStorage was dropped — data preserved in legacy-backup/persistent-storage/`)
      }

      outcome.migrated.push(name)
      log(`> Migrated legacy site '${name}'`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      outcome.skipped.push({ name, reason: `migration failed: ${message} — legacy files kept in legacy-backup/` })
    }
  }

  // Move the legacy directories out of the way (kept as a backup, not deleted).
  const backupDir = join(dataDir, "legacy-backup")
  mkdirSync(backupDir, { recursive: true, mode: 0o755 })
  for (const dir of LEGACY_DIRS) {
    const from = join(dataDir, dir)
    if (!existsSync(from)) continue
    let to = join(backupDir, dir)
    if (existsSync(to)) to = join(backupDir, `${dir}-${Date.now()}`)
    renameSync(from, to)
  }
  log(`> Legacy data moved to ${backupDir} — remove it manually once the migration is verified`)

  return outcome
}
