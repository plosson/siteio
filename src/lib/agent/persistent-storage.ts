import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs"
import { join } from "path"

const MAX_STORAGE_SIZE = 1 * 1024 * 1024 // 1MB

export class PersistentStorageManager {
  private storageDir: string

  constructor(dataDir: string) {
    this.storageDir = join(dataDir, "persistent-storage")
    if (!existsSync(this.storageDir)) {
      mkdirSync(this.storageDir, { recursive: true })
    }
  }

  private getSiteDir(subdomain: string): string {
    return join(this.storageDir, subdomain)
  }

  private getFilePath(subdomain: string, userEmail?: string): string {
    const key = userEmail ? this.sanitizeEmail(userEmail) : "_anonymous"
    return join(this.getSiteDir(subdomain), `${key}.json`)
  }

  private sanitizeEmail(email: string): string {
    return email.toLowerCase().replace(/[^a-z0-9@._-]/g, "_")
  }

  get(subdomain: string, userEmail?: string): Record<string, string> | null {
    const filePath = this.getFilePath(subdomain, userEmail)
    if (!existsSync(filePath)) {
      return null
    }
    try {
      return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, string>
    } catch {
      return null
    }
  }

  set(subdomain: string, data: Record<string, string>, userEmail?: string): void {
    const json = JSON.stringify(data)
    if (json.length > MAX_STORAGE_SIZE) {
      throw new Error(`Storage size exceeds limit of ${MAX_STORAGE_SIZE} bytes`)
    }

    const siteDir = this.getSiteDir(subdomain)
    if (!existsSync(siteDir)) {
      mkdirSync(siteDir, { recursive: true })
    }

    writeFileSync(this.getFilePath(subdomain, userEmail), json)
  }

  deleteSite(subdomain: string): void {
    const siteDir = this.getSiteDir(subdomain)
    if (existsSync(siteDir)) {
      rmSync(siteDir, { recursive: true })
    }
  }
}
