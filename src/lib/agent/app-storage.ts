import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "fs"
import { join } from "path"
import type { App, AppInfo } from "../../types"
import { ValidationError } from "../../utils/errors"
import { SecretCipher } from "./secret-cipher"
import { writeSecureFile } from "./secure-file"

/**
 * Replace the stored secret ciphertext with the list of keys it holds. Every
 * public method returns apps in this shape, so a secret cannot escape storage
 * by a caller forgetting to strip it — only resolveEnv() decrypts, and only to
 * hand the values straight to Docker.
 */
function toPublic(app: App): App {
  const { secrets, ...rest } = app
  const secretKeys = Object.keys(secrets || {})
  return { ...rest, ...(secretKeys.length > 0 && { secretKeys }) }
}

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
   * Encrypt each plaintext secret into `encrypted`, dropping any readable copy
   * from `env` — a key is either public config or a secret, never both.
   * Mutates both maps.
   */
  private encryptInto(
    env: Record<string, string>,
    encrypted: Record<string, string>,
    plaintext: Record<string, string> | undefined
  ): void {
    for (const [key, value] of Object.entries(plaintext || {})) {
      delete env[key]
      encrypted[key] = this.cipher.encrypt(value)
    }
  }

  /** The stored form, secret ciphertext included. Storage-internal. */
  private readRaw(name: string): App | null {
    const path = this.getAppPath(name)
    if (!existsSync(path)) {
      return null
    }
    return JSON.parse(readFileSync(path, "utf-8"))
  }

  private write(app: App): App {
    writeSecureFile(this.getAppPath(app.name), JSON.stringify(app, null, 2))
    return toPublic(app)
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
    this.encryptInto(env, encrypted, secrets)

    const now = new Date().toISOString()
    return this.write({
      ...rest,
      env,
      ...(Object.keys(encrypted).length > 0 && { secrets: encrypted }),
      createdAt: now,
      updatedAt: now,
    })
  }

  get(name: string): App | null {
    const app = this.readRaw(name)
    return app && toPublic(app)
  }

  /**
   * Update an app. `updates.secrets` holds *plaintext* values, encrypted here
   * before they hit disk; `secretKeys` is output-only and is ignored on input.
   */
  update(name: string, updates: Partial<Omit<App, "name" | "createdAt">> & { unsetEnv?: string[] }): App | null {
    const raw = this.readRaw(name)
    if (!raw) {
      return null
    }

    const { secrets: stored, secretKeys: _storedKeys, ...app } = raw
    const { unsetEnv, secrets, secretKeys: _dropKeys, ...appUpdates } = updates

    // Merge env vars additively instead of replacing
    const mergedEnv = { ...(app.env || {}), ...(appUpdates.env || {}) }
    const mergedSecrets = { ...(stored || {}) }

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
    this.encryptInto(mergedEnv, mergedSecrets, secrets)

    // Remove unset keys
    if (unsetEnv) {
      for (const key of unsetEnv) {
        delete mergedEnv[key]
        delete mergedSecrets[key]
      }
    }

    return this.write({
      ...app,
      ...appUpdates,
      env: mergedEnv,
      ...(Object.keys(mergedSecrets).length > 0 && { secrets: mergedSecrets }),
      name: app.name, // Prevent name changes
      createdAt: app.createdAt, // Preserve creation date
      updatedAt: new Date().toISOString(),
    })
  }

  /**
   * Plain env plus decrypted secrets — the full environment handed to Docker
   * when the container is created. The only place secrets leave storage.
   */
  resolveEnv(name: string): Record<string, string> {
    const app = this.readRaw(name)
    if (!app) {
      return {}
    }
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
      return toPublic(JSON.parse(content) as App)
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
