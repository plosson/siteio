import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { UserStore, SESSION_TTL_MS, generatePassword } from "../../lib/agent/user-store.ts"

describe("Unit: UserStore", () => {
  let dataDir: string
  let clock: number
  let store: UserStore

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-users-"))
    clock = Date.parse("2026-10-19T10:00:00.000Z")
    store = new UserStore(dataDir, () => clock)
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  const file = (name: string) => join(dataDir, "users", `${name}.json`)
  const member = (username = "alice", tenant?: string) =>
    store.create({ username, role: "member", tenant, password: "correct horse" })

  test("files are private and hold no password or secret in clear", async () => {
    await member()
    const { secret } = store.addKey("alice", "machine", "alice@mac")
    expect(statSync(join(dataDir, "users")).mode & 0o777).toBe(0o700)
    expect(statSync(file("alice")).mode & 0o777).toBe(0o600)
    const raw = readFileSync(file("alice"), "utf-8")
    expect(raw).not.toContain("correct horse")
    expect(raw).not.toContain(secret)
  })

  test("a username that is not a plain name never becomes a path", async () => {
    for (const bad of ["../x", "a/b", "a.b", "", "-a", "x".repeat(64)]) {
      expect(store.get(bad)).toBeNull()
      await expect(store.create({ username: bad, role: "member", password: "correct horse" })).rejects.toThrow()
      expect(store.delete(bad)).toBe(false)
    }
    expect(existsSync(join(dataDir, "x.json"))).toBe(false)
  })

  test("input usernames are trimmed and lower-cased", async () => {
    await store.create({ username: " Alice ", role: "member", password: "correct horse" })
    expect(store.get("alice")?.username).toBe("alice")
    expect(await store.verifyPassword(" ALICE", "correct horse")).not.toBeNull()
  })

  test("create refuses the admin role, the name admin, an owner without tenant and duplicates", async () => {
    await expect(store.create({ username: "bob", role: "admin", tenant: "x.com", password: "correct horse" })).rejects.toThrow()
    await expect(store.create({ username: "admin", role: "member", password: "correct horse" })).rejects.toThrow()
    await expect(store.create({ username: "bob", role: "owner", password: "correct horse" })).rejects.toThrow()
    await member()
    await expect(member()).rejects.toThrow("already exists")
  })

  test("create accepts a second admin, never the name admin", async () => {
    const bob = await store.create({ username: "bob", role: "admin", password: "correct horse" })
    expect(bob.role).toBe("admin")
    expect(bob.tenant).toBeUndefined()
    expect(store.hasAdmin()).toBe(false) // only the bootstrap admin counts
    await expect(store.create({ username: "admin", role: "admin", password: "correct horse" })).rejects.toThrow()
  })

  test("passwords shorter than 8 or longer than 1024 characters are refused", async () => {
    await expect(store.create({ username: "bob", role: "member", password: "short" })).rejects.toThrow()
    await expect(store.create({ username: "bob", role: "member", password: "x".repeat(1025) })).rejects.toThrow()
  })

  test("verifyPassword: right password, wrong password, unknown user, junk input", async () => {
    await member()
    expect((await store.verifyPassword("alice", "correct horse"))?.username).toBe("alice")
    expect(await store.verifyPassword("alice", "wrong horse")).toBeNull()
    expect(await store.verifyPassword("nobody", "correct horse")).toBeNull()
    expect(await store.verifyPassword("alice", "")).toBeNull()
    expect(await store.verifyPassword(42, {})).toBeNull()
    expect(await store.verifyPassword("alice", "x".repeat(1_000_000))).toBeNull()
  })

  test("a key resolves to its user until it is revoked", async () => {
    await member()
    const { key, secret } = store.addKey("alice", "machine", "alice@mac")
    expect(secret).toStartWith("usr_")
    expect(key.id).toMatch(/^key_[0-9a-f]{8}$/)
    expect(store.resolveKey(secret)?.user.username).toBe("alice")
    expect(store.revokeKey("alice", key.id)).toBe(true)
    expect(store.resolveKey(secret)).toBeNull()
    expect(store.revokeKey("alice", key.id)).toBe(false)
  })

  test("resolveKey ignores non-usr secrets and unknown keys", async () => {
    await member()
    store.addKey("alice", "machine", "m")
    expect(store.resolveKey("god-key")).toBeNull()
    expect(store.resolveKey("usr_nope")).toBeNull()
  })

  test("a key added by another process (another store on the same folder) resolves at once", async () => {
    await member()
    const other = new UserStore(dataDir, () => clock)
    const { secret } = other.addKey("alice", "machine", "m")
    expect(store.resolveKey(secret)?.user.username).toBe("alice")
  })

  test("a session expires after 7 days; a machine key does not", async () => {
    await member()
    const session = store.addKey("alice", "session", "browser")
    const machine = store.addKey("alice", "machine", "m")
    clock += SESSION_TTL_MS
    expect(store.resolveKey(session.secret)).toBeNull()
    expect(store.resolveKey(machine.secret)).not.toBeNull()
    expect(store.activeKeys(store.get("alice")!).map((k) => k.kind)).toEqual(["machine"])
  })

  test("setPassword ends sessions except the kept one, and keeps machine keys", async () => {
    await member()
    const keep = store.addKey("alice", "session", "browser")
    const other = store.addKey("alice", "session", "browser")
    const machine = store.addKey("alice", "machine", "m")
    await store.setPassword("alice", "new password!", keep.key.id)
    expect(store.resolveKey(keep.secret)).not.toBeNull()
    expect(store.resolveKey(other.secret)).toBeNull()
    expect(store.resolveKey(machine.secret)).not.toBeNull()
    expect(await store.verifyPassword("alice", "new password!")).not.toBeNull()
  })

  test("setAdminPassword creates the admin, then resets it and ends its sessions", async () => {
    expect(store.hasAdmin()).toBe(false)
    await store.setAdminPassword("first password")
    expect(store.get("admin")?.role).toBe("admin")
    expect(store.hasAdmin()).toBe(true)
    const session = store.addKey("admin", "session", "browser")
    await store.setAdminPassword("second password")
    expect(store.resolveKey(session.secret)).toBeNull()
    expect(await store.verifyPassword("admin", "second password")).not.toBeNull()
  })

  test("deleteTenantUsers removes only that tenant's users", async () => {
    await member("alice", "friend.com")
    await member("bob", "other.org")
    await member("carol")
    expect(store.deleteTenantUsers("friend.com")).toEqual(["alice"])
    expect(store.list().map((u) => u.username)).toEqual(["bob", "carol"])
  })

  test("an unreadable user file is skipped, the others still work", async () => {
    await member()
    const { secret } = store.addKey("alice", "machine", "m")
    writeFileSync(file("broken"), "{ not json")
    expect(store.list().map((u) => u.username)).toEqual(["alice"])
    expect(store.get("broken")).toBeNull()
    expect(store.resolveKey(secret)?.user.username).toBe("alice")
  })

  test("toInfo and keyInfo never expose hashes", async () => {
    const user = await member()
    const { key } = store.addKey("alice", "machine", "m")
    expect(JSON.stringify(store.toInfo(user))).not.toContain("passwordHash")
    expect(JSON.stringify(store.keyInfo(key))).not.toContain(key.hash)
  })

  test("a key revoked while a password change is hashing stays revoked, and a key added then survives", async () => {
    await member()
    const machine = store.addKey("alice", "machine", "m")
    const pending = store.setPassword("alice", "new password!")
    expect(store.revokeKey("alice", machine.key.id)).toBe(true)
    const added = store.addKey("alice", "machine", "n")
    await pending
    expect(store.resolveKey(machine.secret)).toBeNull()
    expect(store.resolveKey(added.secret)?.user.username).toBe("alice")
  })

  test("two concurrent creates of the same name: exactly one succeeds", async () => {
    const results = await Promise.allSettled([member(), member()])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1)
    expect(store.list().map((u) => u.username)).toEqual(["alice"])
  })

  test("a user file of the wrong shape is skipped, the others still work", async () => {
    await member("alice")
    await member("bob")
    const { secret } = store.addKey("bob", "machine", "m")
    writeFileSync(file("alice"), readFileSync(file("bob"), "utf-8")) // bob's valid content under alice's name
    writeFileSync(file("empty"), "{}")
    writeFileSync(file("list"), "[]")
    writeFileSync(file("num"), "42")
    expect(store.get("alice")).toBeNull()
    expect(store.list().map((u) => u.username)).toEqual(["bob"])
    expect(store.resolveKey(secret)?.user.username).toBe("bob")
    expect(store.resolveKey("usr_nope")).toBeNull()
  })

  test("a user file with a bad key entry or an impossible admin is skipped, the others still work", async () => {
    await member("bob")
    const { secret } = store.addKey("bob", "machine", "m")
    const base = JSON.parse(readFileSync(file("bob"), "utf-8"))
    const goodKey = { id: "key_00000000", hash: "h", kind: "machine", name: "n", createdAt: "2026-10-19T00:00:00.000Z" }
    const put = (name: string, over: Record<string, unknown>) =>
      writeFileSync(file(name), JSON.stringify({ ...base, username: name, keys: [], ...over }))
    put("nullkey", { keys: [null] })
    put("numkey", { keys: [1] })
    put("emptykey", { keys: [{}] })
    put("badkind", { keys: [{ ...goodKey, kind: "root" }] })
    put("nohash", { keys: [{ ...goodKey, hash: 5 }] })
    put("admin", { role: "admin", tenant: "x.com" })
    put("fine", { keys: [goodKey] })
    writeFileSync(file("bobby"), JSON.stringify({ ...base, username: "bobby", role: "admin" }))
    put("bobt", { role: "admin", tenant: "x.com" })
    expect(store.list().map((u) => u.username)).toEqual(["bob", "bobby", "fine"])
    expect(store.hasAdmin()).toBe(false)
    expect(store.resolveKey(secret)?.user.username).toBe("bob")
  })

  test("generatePassword gives distinct 24-character passwords", () => {
    const a = generatePassword()
    expect(a).toHaveLength(24)
    expect(generatePassword()).not.toBe(a)
  })
})
