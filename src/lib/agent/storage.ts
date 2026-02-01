import { existsSync, mkdirSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync, cpSync } from "fs"
import { join } from "path"
import { zipSync } from "fflate"
import type { SiteMetadata, SiteOAuth, SiteVersion } from "../../types.ts"

const MAX_HISTORY_VERSIONS = 10

export class SiteStorage {
  private sitesDir: string
  private metadataDir: string
  private historyDir: string

  constructor(dataDir: string) {
    this.sitesDir = join(dataDir, "sites")
    this.metadataDir = join(dataDir, "metadata")
    this.historyDir = join(dataDir, "history")

    // Ensure directories exist with world-readable permissions (for nginx container access)
    if (!existsSync(this.sitesDir)) {
      mkdirSync(this.sitesDir, { recursive: true, mode: 0o755 })
    }
    if (!existsSync(this.metadataDir)) {
      mkdirSync(this.metadataDir, { recursive: true })
    }
    if (!existsSync(this.historyDir)) {
      mkdirSync(this.historyDir, { recursive: true })
    }
  }

  getSitePath(subdomain: string): string {
    return join(this.sitesDir, subdomain)
  }

  private getMetadataPath(subdomain: string): string {
    return join(this.metadataDir, `${subdomain}.json`)
  }

  private getHistoryPath(subdomain: string): string {
    return join(this.historyDir, subdomain)
  }

  private getNextVersion(subdomain: string): number {
    const historyPath = this.getHistoryPath(subdomain)
    if (!existsSync(historyPath)) {
      return 1
    }
    const versions = readdirSync(historyPath)
      .filter((f) => f.startsWith("v"))
      .map((f) => parseInt(f.slice(1), 10))
      .filter((n) => !isNaN(n))
    return versions.length > 0 ? Math.max(...versions) + 1 : 1
  }

  private archiveCurrentVersion(subdomain: string): void {
    const sitePath = this.getSitePath(subdomain)
    const metadata = this.getMetadata(subdomain)
    if (!existsSync(sitePath) || !metadata) {
      return // Nothing to archive
    }

    const historyPath = this.getHistoryPath(subdomain)
    if (!existsSync(historyPath)) {
      mkdirSync(historyPath, { recursive: true })
    }

    const version = this.getNextVersion(subdomain)
    const versionPath = join(historyPath, `v${version}`)

    // Copy current site to history
    cpSync(sitePath, versionPath, { recursive: true })

    // Save version metadata
    const versionMeta: SiteVersion = {
      version,
      deployedAt: metadata.deployedAt,
      size: metadata.size,
    }
    writeFileSync(join(historyPath, `v${version}.json`), JSON.stringify(versionMeta, null, 2))

    // Prune old versions if we exceed MAX_HISTORY_VERSIONS
    this.pruneHistory(subdomain)
  }

  private pruneHistory(subdomain: string): void {
    const historyPath = this.getHistoryPath(subdomain)
    if (!existsSync(historyPath)) return

    const versions = readdirSync(historyPath)
      .filter((f) => f.startsWith("v") && !f.endsWith(".json"))
      .map((f) => parseInt(f.slice(1), 10))
      .filter((n) => !isNaN(n))
      .sort((a, b) => a - b)

    while (versions.length > MAX_HISTORY_VERSIONS) {
      const oldVersion = versions.shift()!
      const oldPath = join(historyPath, `v${oldVersion}`)
      const oldMetaPath = join(historyPath, `v${oldVersion}.json`)
      if (existsSync(oldPath)) rmSync(oldPath, { recursive: true })
      if (existsSync(oldMetaPath)) rmSync(oldMetaPath)
    }
  }

  async extractAndStore(
    subdomain: string,
    zipData: Uint8Array,
    oauth?: SiteOAuth
  ): Promise<SiteMetadata> {
    const sitePath = this.getSitePath(subdomain)

    // Archive existing site before overwriting
    if (existsSync(sitePath)) {
      this.archiveCurrentVersion(subdomain)
      rmSync(sitePath, { recursive: true })
    }

    // Create site directory with world-readable permissions
    mkdirSync(sitePath, { recursive: true, mode: 0o755 })

    // Extract zip using fflate
    const { unzipSync } = await import("fflate")

    const files: string[] = []
    let totalSize = 0
    const unzipped = unzipSync(zipData)

    for (const [filename, data] of Object.entries(unzipped)) {
      // Skip directories (they end with /)
      if (filename.endsWith("/")) continue

      const filePath = join(sitePath, filename)
      const dirPath = join(sitePath, filename.split("/").slice(0, -1).join("/"))

      // Ensure parent directory exists with world-readable permissions
      if (dirPath !== sitePath && !existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true, mode: 0o755 })
      }

      // Write file with world-readable permissions (0o644)
      await Bun.write(filePath, data, { mode: 0o644 })
      files.push(filename)
      totalSize += data.length
    }

    // Save metadata
    const metadata: SiteMetadata = {
      subdomain,
      size: totalSize,
      deployedAt: new Date().toISOString(),
      files,
      oauth,
    }

    writeFileSync(this.getMetadataPath(subdomain), JSON.stringify(metadata, null, 2))

    return metadata
  }

  getMetadata(subdomain: string): SiteMetadata | null {
    const metadataPath = this.getMetadataPath(subdomain)
    if (!existsSync(metadataPath)) {
      return null
    }
    try {
      return JSON.parse(readFileSync(metadataPath, "utf-8")) as SiteMetadata
    } catch {
      return null
    }
  }

  listSites(): SiteMetadata[] {
    const sites: SiteMetadata[] = []
    if (!existsSync(this.metadataDir)) {
      return sites
    }

    const files = readdirSync(this.metadataDir)
    for (const file of files) {
      if (file.endsWith(".json")) {
        const subdomain = file.slice(0, -5)
        const metadata = this.getMetadata(subdomain)
        if (metadata) {
          sites.push(metadata)
        }
      }
    }

    return sites.sort((a, b) => b.deployedAt.localeCompare(a.deployedAt))
  }

  deleteSite(subdomain: string): boolean {
    const sitePath = this.getSitePath(subdomain)
    const metadataPath = this.getMetadataPath(subdomain)

    let deleted = false

    if (existsSync(sitePath)) {
      rmSync(sitePath, { recursive: true })
      deleted = true
    }

    if (existsSync(metadataPath)) {
      rmSync(metadataPath)
      deleted = true
    }

    return deleted
  }

  siteExists(subdomain: string): boolean {
    return existsSync(this.getSitePath(subdomain)) && existsSync(this.getMetadataPath(subdomain))
  }

  async zipSite(subdomain: string): Promise<Uint8Array | null> {
    const sitePath = this.getSitePath(subdomain)
    if (!existsSync(sitePath)) {
      return null
    }

    const files: Record<string, Uint8Array> = {}

    const collectFiles = (dir: string, baseDir: string = dir): void => {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        const relativePath = fullPath.slice(baseDir.length + 1)
        const stat = statSync(fullPath)

        if (stat.isDirectory()) {
          collectFiles(fullPath, baseDir)
        } else {
          files[relativePath] = readFileSync(fullPath)
        }
      }
    }

    collectFiles(sitePath)
    return zipSync(files, { level: 6 })
  }

  updateOAuth(subdomain: string, oauth: SiteOAuth | null): boolean {
    const metadata = this.getMetadata(subdomain)
    if (!metadata) {
      return false
    }

    if (oauth) {
      metadata.oauth = oauth
    } else {
      delete metadata.oauth
    }

    writeFileSync(this.getMetadataPath(subdomain), JSON.stringify(metadata, null, 2))
    return true
  }

  getHistory(subdomain: string): SiteVersion[] {
    const historyPath = this.getHistoryPath(subdomain)
    if (!existsSync(historyPath)) {
      return []
    }

    const versions: SiteVersion[] = []
    const files = readdirSync(historyPath).filter((f) => f.endsWith(".json"))

    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(historyPath, file), "utf-8")) as SiteVersion
        versions.push(data)
      } catch {
        // Skip invalid files
      }
    }

    // Sort by version descending (newest first)
    return versions.sort((a, b) => b.version - a.version)
  }

  rollback(subdomain: string, version: number): SiteMetadata | null {
    const historyPath = this.getHistoryPath(subdomain)
    const versionPath = join(historyPath, `v${version}`)
    const versionMetaPath = join(historyPath, `v${version}.json`)

    if (!existsSync(versionPath) || !existsSync(versionMetaPath)) {
      return null
    }

    const sitePath = this.getSitePath(subdomain)

    // Archive current version before rollback
    if (existsSync(sitePath)) {
      this.archiveCurrentVersion(subdomain)
      rmSync(sitePath, { recursive: true })
    }

    // Copy version back to live site
    cpSync(versionPath, sitePath, { recursive: true })

    // Read version metadata
    const versionMeta = JSON.parse(readFileSync(versionMetaPath, "utf-8")) as SiteVersion

    // Update site metadata
    const metadata = this.getMetadata(subdomain)
    const files = this.collectFileList(sitePath)
    const newMetadata: SiteMetadata = {
      subdomain,
      size: versionMeta.size,
      deployedAt: new Date().toISOString(),
      files,
      oauth: metadata?.oauth,
    }

    writeFileSync(this.getMetadataPath(subdomain), JSON.stringify(newMetadata, null, 2))
    return newMetadata
  }

  private collectFileList(dir: string, baseDir: string = dir): string[] {
    const files: string[] = []
    const entries = readdirSync(dir)
    for (const entry of entries) {
      const fullPath = join(dir, entry)
      const relativePath = fullPath.slice(baseDir.length + 1)
      const stat = statSync(fullPath)
      if (stat.isDirectory()) {
        files.push(...this.collectFileList(fullPath, baseDir))
      } else {
        files.push(relativePath)
      }
    }
    return files
  }
}
