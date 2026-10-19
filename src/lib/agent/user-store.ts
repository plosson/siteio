import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { randomBytes } from "crypto"
import type { User, UserInfo, UserKey, UserKeyInfo } from "../../types.ts"
import { ValidationError } from "../../utils/errors.ts"
import { generateUserKey, hashGrantToken } from "../../utils/grant-token.ts"
import { NAME_RE } from "./tenants.ts"

export const SESSION_TTL_MS = 7 * 24 * 60 * 60_000
const MIN_PASSWORD = 8
const MAX_PASSWORD = 1024

// A password to print once: 24 base64url characters.
export function generatePassword(): string {
  return randomBytes(18).toString("base64url")
}

function normalize(username: unknown): string {
  return typeof username === "string" ? username.trim().toLowerCase() : ""
}

function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new ValidationError(`Password must be ${MIN_PASSWORD} to ${MAX_PASSWORD} characters`)
  }
  return Bun.password.hash(password)
}

// Checked when the username is unknown, so a miss costs as much as a wrong password.
let placeholderHash: Promise<string> | null = null
const placeholder = () => (placeholderHash ??= Bun.password.hash(randomBytes(16).toString("hex")))

// People who can log in, one JSON file per user under <dataDir>/users/. A user
// holds its keys: one per CLI login ("machine") and one per admin UI session.
// Only the password hash and key hashes are stored. No cache: on-box commands
// (`siteio agent password`) write these files from another process, and a
// server has few users, so every lookup reads the folder.
export class UserStore {
  private dir: string

  constructor(dataDir: string, private now: () => number = Date.now) {
    this.dir = join(dataDir, "users")
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 })
  }

  // The file of a valid username, or null: a name from a request never becomes a path unchecked.
  private path(username: string): string | null {
    return username.length <= 63 && NAME_RE.test(username) ? join(this.dir, `${username}.json`) : null
  }

  private write(user: User): void {
    writeFileSync(this.path(user.username)!, JSON.stringify(user, null, 2), { mode: 0o600 })
  }

  private expired(key: UserKey, now = this.now()): boolean {
    return !!key.expiresAt && Date.parse(key.expiresAt) <= now
  }

  get(username: string): User | null {
    const file = this.path(normalize(username))
    if (!file || !existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, "utf-8")) as User
    } catch {
      return null // a hand-edited or truncated file is no one
    }
  }

  list(): User[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.get(f.slice(0, -".json".length)))
      .filter((u): u is User => u !== null)
      .sort((a, b) => a.username.localeCompare(b.username))
  }

  hasAdmin(): boolean {
    return this.list().some((u) => u.role === "admin")
  }

  async create(input: { username: string; role: "owner" | "member"; tenant?: string; password: string }): Promise<User> {
    const username = normalize(input.username)
    if (!this.path(username)) throw new ValidationError("Username must contain only lowercase letters, numbers, and hyphens")
    if (username === "admin") throw new ValidationError("'admin' is reserved for the server's admin")
    if (input.role !== "owner" && input.role !== "member") throw new ValidationError("Role must be 'owner' or 'member'")
    if (input.role === "owner" && !input.tenant) throw new ValidationError("An owner belongs to a tenant: give its domain")
    if (this.get(username)) throw new ValidationError(`User '${username}' already exists`)
    const user: User = {
      username,
      role: input.role,
      ...(input.tenant && { tenant: input.tenant }),
      passwordHash: await hashPassword(input.password),
      createdAt: new Date(this.now()).toISOString(),
      keys: [],
    }
    this.write(user)
    return user
  }

  // Creates the admin on first use; otherwise resets its password and ends its sessions.
  async setAdminPassword(password: string): Promise<User> {
    const existing = this.get("admin")
    if (existing && existing.role !== "admin") throw new ValidationError("A user named 'admin' exists and is not the admin")
    const user: User = existing ?? { username: "admin", role: "admin", passwordHash: "", createdAt: new Date(this.now()).toISOString(), keys: [] }
    user.passwordHash = await hashPassword(password)
    user.keys = user.keys.filter((k) => k.kind === "machine")
    this.write(user)
    return user
  }

  // Sets the password and ends the user's sessions, except `keepSessionId` (the
  // caller's own). Machine keys keep working.
  async setPassword(username: string, password: string, keepSessionId?: string): Promise<void> {
    const user = this.get(username)
    if (!user) throw new ValidationError(`No user '${normalize(username)}'`)
    user.passwordHash = await hashPassword(password)
    user.keys = user.keys.filter((k) => k.kind === "machine" || k.id === keepSessionId)
    this.write(user)
  }

  // The user, when `password` is theirs. An unknown user costs the same work.
  async verifyPassword(username: unknown, password: unknown): Promise<User | null> {
    if (typeof password !== "string" || password.length === 0 || password.length > MAX_PASSWORD) return null
    const user = this.get(normalize(username))
    const ok = await Bun.password.verify(password, user?.passwordHash || (await placeholder()))
    return user && ok ? user : null
  }

  addKey(username: string, kind: UserKey["kind"], name: string): { key: UserKey; secret: string } {
    const user = this.get(username)
    if (!user) throw new ValidationError(`No user '${normalize(username)}'`)
    const now = this.now()
    const secret = generateUserKey()
    const key: UserKey = {
      id: `key_${randomBytes(4).toString("hex")}`,
      kind,
      name: name.slice(0, 100),
      hash: hashGrantToken(secret),
      createdAt: new Date(now).toISOString(),
      ...(kind === "session" && { expiresAt: new Date(now + SESSION_TTL_MS).toISOString() }),
    }
    user.keys = [...user.keys.filter((k) => !this.expired(k, now)), key]
    this.write(user)
    return { key, secret }
  }

  resolveKey(secret: string): { user: User; key: UserKey } | null {
    if (!secret.startsWith("usr_")) return null
    const hash = hashGrantToken(secret)
    for (const user of this.list()) {
      const key = user.keys.find((k) => k.hash === hash)
      if (key) return this.expired(key) ? null : { user, key }
    }
    return null
  }

  activeKeys(user: User): UserKey[] {
    return user.keys.filter((k) => !this.expired(k))
  }

  revokeKey(username: string, id: string): boolean {
    const user = this.get(username)
    if (!user || !user.keys.some((k) => k.id === id)) return false
    user.keys = user.keys.filter((k) => k.id !== id)
    this.write(user)
    return true
  }

  delete(username: string): boolean {
    const file = this.path(normalize(username))
    if (!file || !existsSync(file)) return false
    rmSync(file)
    return true
  }

  deleteTenantUsers(domain: string): string[] {
    const gone = this.list().filter((u) => u.tenant === domain).map((u) => u.username)
    for (const name of gone) this.delete(name)
    return gone
  }

  toInfo(user: User): UserInfo {
    return { username: user.username, role: user.role, tenant: user.tenant ?? null, createdAt: user.createdAt }
  }

  keyInfo(key: UserKey): UserKeyInfo {
    return { id: key.id, kind: key.kind, name: key.name, createdAt: key.createdAt, ...(key.expiresAt && { expiresAt: key.expiresAt }) }
  }
}
