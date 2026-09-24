import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"

/**
 * Stores per-app compose files: the user's base file (inline uploads only) and
 * the generated siteio override file that injects Traefik routing + network.
 * Git-hosted compose apps keep their base file inside the cloned repo; this
 * storage class only handles the override in that case.
 */
export interface ComposeFilesSnapshot {
  base?: string
  env?: string
}

export class ComposeStorage {
  private composeDir: string

  constructor(dataDir: string) {
    this.composeDir = join(dataDir, "compose")
  }

  /** Parent of every app's compose folder. */
  rootDir(): string {
    return this.composeDir
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

  baseEnvPath(appName: string): string {
    return join(this.appDir(appName), ".env")
  }

  writeBaseEnv(appName: string, content: string): void {
    this.ensureAppDir(appName)
    writeFileSync(this.baseEnvPath(appName), content)
  }

  envFileExists(appName: string): boolean {
    return existsSync(this.baseEnvPath(appName))
  }

  /** Current uploaded compose file and .env, to put back if a change is rejected. */
  snapshot(appName: string): ComposeFilesSnapshot {
    const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf-8") : undefined)
    return { base: read(this.baseInlinePath(appName)), env: read(this.baseEnvPath(appName)) }
  }

  restore(appName: string, snapshot: ComposeFilesSnapshot): void {
    const put = (path: string, content: string | undefined) => {
      if (content !== undefined) writeFileSync(path, content)
      else if (existsSync(path)) rmSync(path)
    }
    this.ensureAppDir(appName)
    put(this.baseInlinePath(appName), snapshot.base)
    put(this.baseEnvPath(appName), snapshot.env)
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
