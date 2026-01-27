import { existsSync, mkdirSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import type { SiteMetadata } from "../../types.ts"

export class SiteStorage {
  private sitesDir: string
  private metadataDir: string

  constructor(dataDir: string) {
    this.sitesDir = join(dataDir, "sites")
    this.metadataDir = join(dataDir, "metadata")

    // Ensure directories exist
    if (!existsSync(this.sitesDir)) {
      mkdirSync(this.sitesDir, { recursive: true })
    }
    if (!existsSync(this.metadataDir)) {
      mkdirSync(this.metadataDir, { recursive: true })
    }
  }

  getSitePath(subdomain: string): string {
    return join(this.sitesDir, subdomain)
  }

  private getMetadataPath(subdomain: string): string {
    return join(this.metadataDir, `${subdomain}.json`)
  }

  async extractAndStore(
    subdomain: string,
    zipData: Uint8Array,
    auth?: { user: string; passwordHash: string }
  ): Promise<SiteMetadata> {
    const sitePath = this.getSitePath(subdomain)

    // Remove existing site if it exists
    if (existsSync(sitePath)) {
      rmSync(sitePath, { recursive: true })
    }

    // Create site directory
    mkdirSync(sitePath, { recursive: true })

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

      // Ensure parent directory exists
      if (dirPath !== sitePath && !existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true })
      }

      // Write file
      await Bun.write(filePath, data)
      files.push(filename)
      totalSize += data.length
    }

    // Save metadata
    const metadata: SiteMetadata = {
      subdomain,
      size: totalSize,
      deployedAt: new Date().toISOString(),
      files,
      auth,
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

  updateAuth(subdomain: string, auth: { user: string; passwordHash: string } | null): boolean {
    const metadata = this.getMetadata(subdomain)
    if (!metadata) {
      return false
    }

    if (auth) {
      metadata.auth = auth
    } else {
      delete metadata.auth
    }

    writeFileSync(this.getMetadataPath(subdomain), JSON.stringify(metadata, null, 2))
    return true
  }
}
