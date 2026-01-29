import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import type { App, AppInfo, SiteOAuth } from "../../types"
import { ValidationError } from "../../utils/errors"

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

  private validateName(name: string): void {
    if (!name) {
      throw new ValidationError("App name cannot be empty")
    }
    if (!/^[a-z0-9-]+$/.test(name)) {
      throw new ValidationError("App name must contain only lowercase letters, numbers, and hyphens")
    }
    if (name === "api") {
      throw new ValidationError("'api' is a reserved name")
    }
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

  update(name: string, updates: Partial<Omit<App, "name" | "createdAt">>): App | null {
    const app = this.get(name)
    if (!app) {
      return null
    }

    const updated: App = {
      ...app,
      ...updates,
      name: app.name, // Prevent name changes
      createdAt: app.createdAt, // Preserve creation date
      updatedAt: new Date().toISOString(),
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

  toInfo(app: App): AppInfo {
    return {
      name: app.name,
      type: app.type,
      image: app.image,
      status: app.status,
      domains: app.domains,
      internalPort: app.internalPort,
      deployedAt: app.deployedAt,
      createdAt: app.createdAt,
    }
  }

  createStaticSiteApp(name: string, sitePath: string, oauth?: SiteOAuth): App {
    return this.create({
      name,
      type: "static",
      image: "nginx:alpine",
      internalPort: 80,
      restartPolicy: "unless-stopped",
      volumes: [
        {
          name: sitePath,
          mountPath: "/usr/share/nginx/html",
          readonly: true,
        },
      ],
      oauth,
      env: {},
      domains: [],
      status: "pending",
    })
  }
}
