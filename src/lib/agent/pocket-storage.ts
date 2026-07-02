import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, cpSync,
} from "fs"
import { join, resolve, sep } from "path"
import { unzipSync } from "fflate"
import type { Pocket, PocketInfo } from "../../types.ts"
import { ValidationError } from "../../utils/errors.ts"

const MAX_HISTORY_VERSIONS = 10

export class PocketStorage {
  private metaDir: string
  private codeDir: string
  private dataDir: string
  private historyDir: string

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
    if (!name) throw new ValidationError("Pocket name cannot be empty")
    if (!/^[a-z0-9-]+$/.test(name)) {
      throw new ValidationError("Pocket name must contain only lowercase letters, numbers, and hyphens")
    }
    if (name === "api") throw new ValidationError("'api' is a reserved name")
  }

  private metaPath(name: string): string { return join(this.metaDir, `${name}.json`) }
  getCodePath(name: string): string { return join(this.codeDir, name) }
  getDataPath(name: string): string { return join(this.dataDir, name) }
  private historyPath(name: string): string { return join(this.historyDir, name) }

  create(data: Omit<Pocket, "createdAt" | "updatedAt">): Pocket {
    this.validateName(data.name)
    if (this.exists(data.name)) throw new ValidationError(`Pocket '${data.name}' already exists`)
    const now = new Date().toISOString()
    const pocket: Pocket = { ...data, createdAt: now, updatedAt: now }
    writeFileSync(this.metaPath(pocket.name), JSON.stringify(pocket, null, 2))
    return pocket
  }

  get(name: string): Pocket | null {
    const p = this.metaPath(name)
    if (!existsSync(p)) return null
    try { return JSON.parse(readFileSync(p, "utf-8")) as Pocket } catch { return null }
  }

  update(name: string, updates: Partial<Omit<Pocket, "name" | "createdAt">>): Pocket | null {
    const pocket = this.get(name)
    if (!pocket) return null
    const updated: Pocket = {
      ...pocket, ...updates,
      name: pocket.name, createdAt: pocket.createdAt, updatedAt: new Date().toISOString(),
    }
    writeFileSync(this.metaPath(name), JSON.stringify(updated, null, 2))
    return updated
  }

  exists(name: string): boolean { return existsSync(this.metaPath(name)) }

  list(): Pocket[] {
    if (!existsSync(this.metaDir)) return []
    return readdirSync(this.metaDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.metaDir, f), "utf-8")) as Pocket)
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
    // Prune
    const versions = readdirSync(h)
      .filter((f) => f.startsWith("v") && !f.endsWith(".json"))
      .map((f) => parseInt(f.slice(1), 10)).filter((n) => !isNaN(n)).sort((a, b) => a - b)
    while (versions.length > MAX_HISTORY_VERSIONS) {
      const old = versions.shift()!
      const p = join(h, `v${old}`)
      if (existsSync(p)) rmSync(p, { recursive: true })
    }
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
    const unzipped = unzipSync(zipData)
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

  // The pocket's primary hostname: its first custom domain, else the default
  // `<name>.<domain>` subdomain. Single source of truth for URL construction.
  primaryDomain(pocket: Pocket, domain: string): string {
    return pocket.domains[0] || `${pocket.name}.${domain}`
  }

  toInfo(pocket: Pocket, domain: string): PocketInfo {
    const primary = this.primaryDomain(pocket, domain)
    return {
      name: pocket.name,
      url: `https://${primary}`,
      adminUrl: `https://${primary}/_/`,
      domains: pocket.domains,
      status: pocket.status,
      pocketbaseVersion: pocket.pocketbaseVersion,
      size: pocket.size,
      version: pocket.version,
      deployedAt: pocket.deployedAt,
      createdAt: pocket.createdAt,
    }
  }
}
