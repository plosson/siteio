import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"

/**
 * Stores per-app compose files: the user's base file (inline uploads only) and
 * the generated siteio override file that injects Traefik routing + network.
 * Git-hosted compose apps keep their base file inside the cloned repo; this
 * storage class only handles the override in that case.
 */
export class ComposeStorage {
  private composeDir: string

  constructor(dataDir: string) {
    this.composeDir = join(dataDir, "compose")
  }

  private appDir(appName: string): string {
    return join(this.composeDir, appName)
  }

  private ensureAppDir(appName: string): string {
    const dir = this.appDir(appName)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  baseInlinePath(appName: string): string {
    return join(this.appDir(appName), "docker-compose.yml")
  }

  overridePath(appName: string): string {
    return join(this.appDir(appName), "docker-compose.siteio.yml")
  }

  writeBaseInline(appName: string, content: string): void {
    this.ensureAppDir(appName)
    writeFileSync(this.baseInlinePath(appName), content)
  }

  writeOverride(appName: string, content: string): void {
    this.ensureAppDir(appName)
    writeFileSync(this.overridePath(appName), content)
  }

  exists(appName: string): boolean {
    return existsSync(this.baseInlinePath(appName))
  }

  remove(appName: string): void {
    const dir = this.appDir(appName)
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
