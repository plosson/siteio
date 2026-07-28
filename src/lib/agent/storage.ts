import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, cpSync, statSync,
} from "fs"
import { join, resolve, sep } from "path"
import { unzipSync, zipSync } from "fflate"
import type { Site, SiteInfo, SiteVersion } from "../../types.ts"
import { ValidationError } from "../../utils/errors.ts"

const MAX_HISTORY_VERSIONS = 10

export class SiteStorage {
  private metaDir: string
  private codeDir: string
  private dataDir: string
  private historyDir: string

  // On-disk directory names keep the historical "pocket" prefix: renaming
  // them would break the volume mounts of every already-deployed site's
  // container for zero user-visible benefit.
  constructor(dataDir: string) {
    this.metaDir = join(dataDir, "pockets")
    this.codeDir = join(dataDir, "pocket-code")
    this.dataDir = join(dataDir, "pocket-data")
    this.historyDir = join(dataDir, "pocket-history")
    for (const d of [this.metaDir, this.codeDir, this.dataDir, this.historyDir]) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o755 })
    }
  }

  private validateName(name: string): void {
    if (!name) throw new ValidationError("Site name cannot be empty")
    if (!/^[a-z0-9-]+$/.test(name)) {
      throw new ValidationError("Site name must contain only lowercase letters, numbers, and hyphens")
    }
    if (name === "api") throw new ValidationError("'api' is a reserved name")
  }

  private metaPath(name: string): string { return join(this.metaDir, `${name}.json`) }
  getCodePath(name: string): string { return join(this.codeDir, name) }
  getDataPath(name: string): string { return join(this.dataDir, name) }
  private historyPath(name: string): string { return join(this.historyDir, name) }

  create(data: Omit<Site, "createdAt" | "updatedAt">): Site {
    this.validateName(data.name)
    if (this.exists(data.name)) throw new ValidationError(`Site '${data.name}' already exists`)
    const now = new Date().toISOString()
    const site: Site = { ...data, createdAt: now, updatedAt: now }
    writeFileSync(this.metaPath(site.name), JSON.stringify(site, null, 2))
    return site
  }

  get(name: string): Site | null {
    const p = this.metaPath(name)
    if (!existsSync(p)) return null
    try { return JSON.parse(readFileSync(p, "utf-8")) as Site } catch { return null }
  }

  update(name: string, updates: Partial<Omit<Site, "name" | "createdAt">>): Site | null {
    const site = this.get(name)
    if (!site) return null
    const updated: Site = {
      ...site, ...updates,
      name: site.name, createdAt: site.createdAt, updatedAt: new Date().toISOString(),
    }
    writeFileSync(this.metaPath(name), JSON.stringify(updated, null, 2))
    return updated
  }

  exists(name: string): boolean { return existsSync(this.metaPath(name)) }

  list(): Site[] {
    if (!existsSync(this.metaDir)) return []
    return readdirSync(this.metaDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.metaDir, f), "utf-8")) as Site)
      .sort((a, b) => (b.deployedAt || "").localeCompare(a.deployedAt || ""))
  }

  delete(name: string): boolean {
    let deleted = false
    for (const p of [this.metaPath(name), this.getCodePath(name), this.getDataPath(name), this.historyPath(name)]) {
      if (existsSync(p)) { rmSync(p, { recursive: true }); deleted = true }
    }
    return deleted
  }

  private nextVersion(name: string): number {
    const h = this.historyPath(name)
    if (!existsSync(h)) return 1
    const versions = readdirSync(h)
      .filter((f) => f.startsWith("v") && !f.endsWith(".json"))
      .map((f) => parseInt(f.slice(1), 10))
      .filter((n) => !isNaN(n))
    return versions.length > 0 ? Math.max(...versions) + 1 : 1
  }

  private archiveCode(name: string): void {
    const codePath = this.getCodePath(name)
    if (!existsSync(codePath)) return
    const h = this.historyPath(name)
    if (!existsSync(h)) mkdirSync(h, { recursive: true })
    const version = this.nextVersion(name)
    cpSync(codePath, join(h, `v${version}`), { recursive: true })

    // Version metadata for `history`/`rollback`. The archived code IS the
    // currently-deployed version, so its metadata comes from the site meta.
    const meta = this.get(name)
    const versionMeta: SiteVersion = {
      version,
      deployedAt: meta?.deployedAt || new Date().toISOString(),
      deployedBy: meta?.deployedBy,
      size: meta?.size ?? 0,
    }
    writeFileSync(join(h, `v${version}.json`), JSON.stringify(versionMeta, null, 2))

    // Prune
    const versions = readdirSync(h)
      .filter((f) => f.startsWith("v") && !f.endsWith(".json"))
      .map((f) => parseInt(f.slice(1), 10)).filter((n) => !isNaN(n)).sort((a, b) => a - b)
    while (versions.length > MAX_HISTORY_VERSIONS) {
      const old = versions.shift()!
      for (const p of [join(h, `v${old}`), join(h, `v${old}.json`)]) {
        if (existsSync(p)) rmSync(p, { recursive: true })
      }
    }
  }

  getHistory(name: string): SiteVersion[] {
    const h = this.historyPath(name)
    if (!existsSync(h)) return []
    const versions: SiteVersion[] = []
    for (const file of readdirSync(h).filter((f) => f.endsWith(".json"))) {
      try {
        versions.push(JSON.parse(readFileSync(join(h, file), "utf-8")) as SiteVersion)
      } catch {
        // Skip invalid files
      }
    }
    return versions.sort((a, b) => b.version - a.version)
  }

  // Restore an archived code version. Archives the current code first, then
  // copies the requested version back. NEVER touches pb_data — rollback is
  // code-only (the design's code/data boundary). Returns null if the version
  // is not in history. The caller must recreate the container: the bind mount
  // references the old code dir inode.
  restoreVersion(name: string, version: number): { size: number; version: number } | null {
    const h = this.historyPath(name)
    const versionPath = join(h, `v${version}`)
    const versionMetaPath = join(h, `v${version}.json`)
    if (!existsSync(versionPath) || !existsSync(versionMetaPath)) return null

    const codePath = this.getCodePath(name)
    if (existsSync(codePath)) {
      this.archiveCode(name)
      rmSync(codePath, { recursive: true })
    }
    cpSync(versionPath, codePath, { recursive: true })

    const versionMeta = JSON.parse(readFileSync(versionMetaPath, "utf-8")) as SiteVersion
    return { size: versionMeta.size, version: this.nextVersion(name) }
  }

  // Move metadata, code, data, and history to a new name. The caller must
  // remove the container before calling this (the volume mounts reference the
  // old paths) and recreate it after.
  rename(oldName: string, newName: string): Site | null {
    this.validateName(newName)
    const site = this.get(oldName)
    if (!site) return null
    if (this.exists(newName)) throw new ValidationError(`Site '${newName}' already exists`)

    for (const [from, to] of [
      [this.getCodePath(oldName), this.getCodePath(newName)],
      [this.getDataPath(oldName), this.getDataPath(newName)],
      [this.historyPath(oldName), this.historyPath(newName)],
    ] as const) {
      if (existsSync(from)) {
        cpSync(from, to, { recursive: true })
        rmSync(from, { recursive: true })
      }
    }

    const renamed: Site = { ...site, name: newName, updatedAt: new Date().toISOString() }
    writeFileSync(this.metaPath(newName), JSON.stringify(renamed, null, 2))
    rmSync(this.metaPath(oldName))
    return renamed
  }

  // Extract an uploaded code zip (public/**, pb_migrations/**, pb_hooks/**) to
  // the read-only mount source. NEVER touches the pb_data volume.
  async extractCode(name: string, zipData: Uint8Array): Promise<{ size: number; version: number }> {
    const codePath = this.getCodePath(name)
    if (existsSync(codePath)) {
      this.archiveCode(name)
      rmSync(codePath, { recursive: true })
    }
    mkdirSync(codePath, { recursive: true, mode: 0o755 })

    let size = 0
    const resolvedBase = resolve(codePath)
    let unzipped = unzipSync(zipData)

    // Back-compat with pre-merge CLIs that upload a flat static-site zip:
    // if no entry lives under a known code dir, treat everything as web root.
    const codeDirs = ["public/", "pb_migrations/", "pb_hooks/"]
    const isFlatZip = !Object.keys(unzipped).some((f) => codeDirs.some((d) => f.startsWith(d)))
    if (isFlatZip) {
      unzipped = Object.fromEntries(
        Object.entries(unzipped).map(([f, data]) => [`public/${f}`, data])
      )
    }

    for (const [filename, data] of Object.entries(unzipped)) {
      if (filename.endsWith("/")) continue
      const filePath = join(codePath, filename)
      const resolved = resolve(filePath)
      if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + sep)) {
        throw new ValidationError(`Unsafe path in upload: ${filename}`)
      }
      mkdirSync(join(filePath, ".."), { recursive: true, mode: 0o755 })
      await Bun.write(filePath, data, { mode: 0o644 })
      size += data.length
    }
    // Ensure PocketBase's expected subdirs exist even if the upload omitted them.
    for (const sub of ["public", "pb_migrations", "pb_hooks"]) {
      const p = join(codePath, sub)
      if (!existsSync(p)) mkdirSync(p, { recursive: true, mode: 0o755 })
    }

    const version = this.nextVersion(name)
    return { size, version }
  }

  // Zip the site's deployed code (public/**, pb_migrations/**, pb_hooks/**)
  // for download. The reverse of extractCode; NEVER includes pb_data.
  async zipCode(name: string): Promise<Uint8Array | null> {
    const codePath = this.getCodePath(name)
    if (!existsSync(codePath)) return null
    const files: Record<string, Uint8Array> = {}
    const collect = (dir: string, base: string = dir): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        const rel = full.slice(base.length + 1)
        if (statSync(full).isDirectory()) collect(full, base)
        else files[rel] = readFileSync(full)
      }
    }
    collect(codePath)
    return zipSync(files, { level: 6 })
  }

  // The site's primary hostname: always the default `<name>.<domain>`
  // subdomain. Single source of truth for URL construction.
  primaryDomain(site: Site, domain: string): string {
    return `${site.name}.${domain}`
  }

  // Custom domains only. Earlier deploys stored the default subdomain inside
  // `domains` — filter it out defensively so those records need no migration.
  customDomains(site: Site, domain: string): string[] {
    return site.domains.filter((d) => d !== `${site.name}.${domain}`)
  }

  // All hostnames the container should route: default subdomain + customs.
  allDomains(site: Site, domain: string): string[] {
    return [this.primaryDomain(site, domain), ...this.customDomains(site, domain)]
  }

  // Reverse lookup: the site that owns a custom domain host (e.g. the sharing
  // endpoints resolve which site a request on a vanity domain belongs to).
  findByCustomDomain(host: string, domain: string): Site | null {
    for (const site of this.list()) {
      if (this.customDomains(site, domain).includes(host)) return site
    }
    return null
  }

  toInfo(site: Site, domain: string): SiteInfo {
    const primary = this.primaryDomain(site, domain)
    return {
      name: site.name,
      url: `https://${primary}`,
      adminUrl: `https://${primary}/_/`,
      domains: this.customDomains(site, domain),
      status: site.status,
      pocketbaseVersion: site.pocketbaseVersion,
      size: site.size,
      version: site.version,
      deployedAt: site.deployedAt,
      createdAt: site.createdAt,
    }
  }
}
