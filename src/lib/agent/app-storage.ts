import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import type { App, AppInfo } from "../../types"
import { ValidationError } from "../../utils/errors"
import { SecretCipher } from "./secret-cipher"

export class AppStorage {
  private appsDir: string
  private cipher: SecretCipher

  constructor(dataDir: string) {
    this.appsDir = join(dataDir, "apps")
    this.cipher = new SecretCipher(dataDir)
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

  /**
   * Create an app. `appData.secrets` holds *plaintext* values — they are
   * encrypted here so no caller has to handle ciphertext.
   */
  create(appData: Omit<App, "createdAt" | "updatedAt">): App {
    this.validateName(appData.name)

    if (this.exists(appData.name)) {
      throw new ValidationError(`App '${appData.name}' already exists`)
    }

    const { secrets, secretKeys: _dropKeys, ...rest } = appData
    const env = { ...(rest.env || {}) }
    const encrypted: Record<string, string> = {}
    for (const [key, value] of Object.entries(secrets || {})) {
      // A key is either public config or a secret, never both.
      delete env[key]
      encrypted[key] = this.cipher.encrypt(value)
    }

    const now = new Date().toISOString()
    const app: App = {
      ...rest,
      env,
      ...(Object.keys(encrypted).length > 0 && { secrets: encrypted }),
      createdAt: now,
      updatedAt: now,
    }

    writeFileSync(this.getAppPath(app.name), JSON.stringify(app, null, 2), { mode: 0o600 })
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
   * Update an app. `updates.secrets` holds *plaintext* values, encrypted here
   * before they hit disk; `secretKeys` is output-only and is ignored on input.
   */
  update(name: string, updates: Partial<Omit<App, "name" | "createdAt">> & { unsetEnv?: string[] }): App | null {
    const app = this.get(name)
    if (!app) {
      return null
    }

    const { unsetEnv, secrets, secretKeys: _dropKeys, ...appUpdates } = updates

    // Merge env vars additively instead of replacing
    const mergedEnv = { ...(app.env || {}), ...(appUpdates.env || {}) }
    const mergedSecrets = { ...(app.secrets || {}) }

    // Refuse to demote a secret to a plaintext env var. The stored value can
    // never be read back, so a stray `-e KEY=...` on a secret key is far more
    // likely a mistake than an intent to publish it.
    for (const key of Object.keys(appUpdates.env || {})) {
      if (mergedSecrets[key]) {
        throw new ValidationError(
          `'${key}' is a secret. Set it with --secret ${key}=<value>, or remove it first with 'apps unset -e ${key}'`
        )
      }
    }

    // Promoting an existing plaintext var to a secret drops the readable copy.
    for (const [key, value] of Object.entries(secrets || {})) {
      delete mergedEnv[key]
      mergedSecrets[key] = this.cipher.encrypt(value)
    }

    // Remove unset keys
    if (unsetEnv) {
      for (const key of unsetEnv) {
        delete mergedEnv[key]
        delete mergedSecrets[key]
      }
    }

    const updated: App = {
      ...app,
      ...appUpdates,
      env: mergedEnv,
      secrets: mergedSecrets,
      name: app.name, // Prevent name changes
      createdAt: app.createdAt, // Preserve creation date
      updatedAt: new Date().toISOString(),
    }
    if (Object.keys(mergedSecrets).length === 0) {
      delete updated.secrets
    }
    delete updated.secretKeys

    // chmod as well as mode: `mode` only applies when the file is created, and
    // apps written by older agents are still 0644.
    writeFileSync(this.getAppPath(name), JSON.stringify(updated, null, 2), { mode: 0o600 })
    chmodSync(this.getAppPath(name), 0o600)
    return updated
  }

  /**
   * Plain env plus decrypted secrets — the full environment handed to Docker
   * when the container is created. The only place secrets leave storage.
   */
  resolveEnv(app: App): Record<string, string> {
    const env = { ...(app.env || {}) }
    for (const [key, blob] of Object.entries(app.secrets || {})) {
      env[key] = this.cipher.decrypt(blob)
    }
    return env
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

  toInfo(app: App, domain: string): AppInfo {
    return {
      name: app.name,
      type: app.type,
      url: `https://${app.name}.${domain}`,
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
    }
  }

}
