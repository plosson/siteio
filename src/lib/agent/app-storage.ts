import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import type { App, AppInfo } from "../../types"
import { ValidationError } from "../../utils/errors"
import { applyEnvUpdate } from "./env"

export class AppStorage {
  private appsDir: string

  constructor(dataDir: string) {
    this.appsDir = join(dataDir, "apps")
    this.ensureDirectories()
  }

  private ensureDirectories(): void {
    if (!existsSync(this.appsDir)) {
      mkdirSync(this.appsDir, { recursive: true })
    }
  }

  // Charset only. The server checks a *new* name as its scope sees it
  // (assertValidNewName), so a tenant app can be stored under its key.
  private validateName(name: string): void {
    if (!name) throw new ValidationError("App name cannot be empty")
    if (!/^[a-z0-9-]+$/.test(name)) {
      throw new ValidationError("App name must contain only lowercase letters, numbers, and hyphens")
    }
    if (name === "api") throw new ValidationError("'api' is a reserved name")
  }

  private getAppPath(name: string): string {
    return join(this.appsDir, `${name}.json`)
  }

  create(appData: Omit<App, "createdAt" | "updatedAt">): App {
    this.validateName(appData.name)

    if (this.exists(appData.name)) {
      throw new ValidationError(`App '${appData.name}' already exists`)
    }

    const now = new Date().toISOString()
    const app: App = {
      ...appData,
      createdAt: now,
      updatedAt: now,
    }

    writeFileSync(this.getAppPath(app.name), JSON.stringify(app, null, 2))
    return app
  }

  get(name: string): App | null {
    const path = this.getAppPath(name)
    if (!existsSync(path)) {
      return null
    }
    return JSON.parse(readFileSync(path, "utf-8"))
  }

  /**
   * Update an app. `updates.secrets` are env vars whose keys get marked secret,
   * so the API stops returning their values; `secretKeys` itself is derived
   * here and ignored on input.
   */
  update(
    name: string,
    updates: Partial<Omit<App, "name" | "createdAt">> & { secrets?: Record<string, string>; unsetEnv?: string[] }
  ): App | null {
    const app = this.get(name)
    if (!app) {
      return null
    }

    const { unsetEnv, secrets, secretKeys: _derived, ...appUpdates } = updates

    const envState = applyEnvUpdate(app, { env: appUpdates.env, secrets, unsetEnv }, "apps")

    const updated: App = {
      ...app,
      ...appUpdates,
      ...envState,
      name: app.name, // Prevent name changes
      createdAt: app.createdAt, // Preserve creation date
      updatedAt: new Date().toISOString(),
    }
    if (!envState.secretKeys) {
      delete updated.secretKeys
    }

    writeFileSync(this.getAppPath(name), JSON.stringify(updated, null, 2))
    return updated
  }

  delete(name: string): boolean {
    const path = this.getAppPath(name)
    if (!existsSync(path)) {
      return false
    }
    rmSync(path)
    return true
  }

  exists(name: string): boolean {
    return existsSync(this.getAppPath(name))
  }

  list(): App[] {
    if (!existsSync(this.appsDir)) {
      return []
    }

    const files = readdirSync(this.appsDir).filter((f) => f.endsWith(".json"))
    return files.map((f) => {
      const content = readFileSync(join(this.appsDir, f), "utf-8")
      return JSON.parse(content) as App
    })
  }

  /** Hostnames Traefik routes to the app: its custom domains, else `<app>.<domain>`. */
  routedDomains(app: Pick<App, "name" | "domains">, domain: string): string[] {
    return app.domains.length > 0 ? app.domains : [`${app.name}.${domain}`]
  }

  /** Public URL the app is served at: its first routed domain. */
  url(app: Pick<App, "name" | "domains">, domain: string): string {
    return `https://${this.routedDomains(app, domain)[0]}`
  }

  toInfo(app: App, domain: string): AppInfo {
    return {
      name: app.name,
      type: app.type,
      url: this.url(app, domain),
      image: app.image,
      git: app.git,
      dockerfile: app.dockerfile,
      compose: app.compose,
      status: app.status,
      domains: app.domains,
      internalPort: app.internalPort,
      deployedAt: app.deployedAt,
      createdAt: app.createdAt,
      commitHash: app.commitHash,
      lastBuildAt: app.lastBuildAt,
      autoDeployRef: app.autoDeployRef,
      autoDeployCheckedAt: app.autoDeployCheckedAt,
      autoDeployError: app.autoDeployError,
    }
  }

}
