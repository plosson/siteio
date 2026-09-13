import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AppStorage } from "../../lib/agent/app-storage"
import type { App, AppType, ContainerStatus, RestartPolicy } from "../../types"

describe("Unit: AppStorage", () => {
  let testDir: string
  let storage: AppStorage

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "siteio-test-"))
    storage = new AppStorage(testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  const createTestApp = (name: string, overrides: Partial<App> = {}): Omit<App, "createdAt" | "updatedAt"> => ({
    name,
    type: "container" as AppType,
    image: "nginx:alpine",
    env: {},
    volumes: [],
    internalPort: 80,
    restartPolicy: "unless-stopped" as RestartPolicy,
    domains: [`${name}.example.com`],
    status: "pending" as ContainerStatus,
    ...overrides,
  })

  test("should create an app", () => {
    const appData = createTestApp("myapp")
    const app = storage.create(appData)

    expect(app.name).toBe("myapp")
    expect(app.type).toBe("container")
    expect(app.status).toBe("pending")
    expect(app.createdAt).toBeDefined()
    expect(app.updatedAt).toBeDefined()
  })

  test("should get an app by name", () => {
    storage.create(createTestApp("myapp"))
    const app = storage.get("myapp")

    expect(app).not.toBeNull()
    expect(app!.name).toBe("myapp")
  })

  test("should return null for non-existent app", () => {
    const app = storage.get("nonexistent")
    expect(app).toBeNull()
  })

  test("should list all apps", () => {
    storage.create(createTestApp("app1"))
    storage.create(createTestApp("app2"))
    storage.create(createTestApp("app3"))

    const apps = storage.list()
    expect(apps).toHaveLength(3)
    expect(apps.map((a) => a.name).sort()).toEqual(["app1", "app2", "app3"])
  })

  test("should update an app", () => {
    storage.create(createTestApp("myapp"))
    const updated = storage.update("myapp", {
      status: "running",
      containerId: "abc123",
    })

    expect(updated).not.toBeNull()
    expect(updated!.status).toBe("running")
    expect(updated!.containerId).toBe("abc123")
  })

  test("should return null when updating non-existent app", () => {
    const result = storage.update("nonexistent", { status: "running" })
    expect(result).toBeNull()
  })

  test("should delete an app", () => {
    storage.create(createTestApp("myapp"))
    const deleted = storage.delete("myapp")

    expect(deleted).toBe(true)
    expect(storage.get("myapp")).toBeNull()
  })

  test("should return false when deleting non-existent app", () => {
    const deleted = storage.delete("nonexistent")
    expect(deleted).toBe(false)
  })

  test("should check if app exists", () => {
    storage.create(createTestApp("myapp"))

    expect(storage.exists("myapp")).toBe(true)
    expect(storage.exists("nonexistent")).toBe(false)
  })

  test("should persist apps across instances", () => {
    storage.create(createTestApp("myapp"))

    // Create new storage instance pointing to same directory
    const storage2 = new AppStorage(testDir)
    const app = storage2.get("myapp")

    expect(app).not.toBeNull()
    expect(app!.name).toBe("myapp")
  })

  test("should reject invalid app names", () => {
    expect(() => storage.create(createTestApp("My App"))).toThrow()
    expect(() => storage.create(createTestApp("my_app"))).toThrow()
    expect(() => storage.create(createTestApp("api"))).toThrow()
    expect(() => storage.create(createTestApp(""))).toThrow()
  })

  test("should reject duplicate app names", () => {
    storage.create(createTestApp("myapp"))
    expect(() => storage.create(createTestApp("myapp"))).toThrow()
  })

  describe("secrets", () => {
    const appFile = () => readFileSync(join(testDir, "apps", "myapp.json"), "utf-8")
    const stored = () => JSON.parse(appFile()) as App

    test("stores secret values encrypted, never in the clear", () => {
      storage.create(createTestApp("myapp", { secrets: { API_TOKEN: "s3cr3t-value" } }))

      expect(appFile()).not.toContain("s3cr3t-value")
      expect(Object.keys(stored().secrets!)).toEqual(["API_TOKEN"])
      expect(stored().secrets!.API_TOKEN).toStartWith("enc:v1:")
    })

    test("never hands the ciphertext back out — only the key names", () => {
      storage.create(createTestApp("myapp", { secrets: { API_TOKEN: "s3cr3t" } }))

      for (const app of [storage.get("myapp")!, storage.list()[0]!, storage.update("myapp", { status: "running" })!]) {
        expect(app.secrets).toBeUndefined()
        expect(app.secretKeys).toEqual(["API_TOKEN"])
      }
    })

    test("writes app files 0600", () => {
      storage.create(createTestApp("myapp", { secrets: { API_TOKEN: "x" } }))
      const path = join(testDir, "apps", "myapp.json")
      expect(statSync(path).mode & 0o777).toBe(0o600)

      storage.update("myapp", { status: "running" })
      expect(statSync(path).mode & 0o777).toBe(0o600)
    })

    test("writes app files 0600 even over a record an older agent left 0644", () => {
      storage.create(createTestApp("myapp"))
      const path = join(testDir, "apps", "myapp.json")
      chmodSync(path, 0o644)

      storage.update("myapp", { status: "running" })
      expect(statSync(path).mode & 0o777).toBe(0o600)
    })

    test("resolveEnv merges plain env with decrypted secrets", () => {
      storage.create(createTestApp("myapp", { env: { NODE_ENV: "production" }, secrets: { API_TOKEN: "s3cr3t" } }))

      expect(storage.resolveEnv("myapp")).toEqual({ NODE_ENV: "production", API_TOKEN: "s3cr3t" })
    })

    test("resolveEnv is empty for an unknown app", () => {
      expect(storage.resolveEnv("nonexistent")).toEqual({})
    })

    test("adds and updates secrets through update()", () => {
      storage.create(createTestApp("myapp"))

      storage.update("myapp", { secrets: { A: "one" } })
      storage.update("myapp", { secrets: { B: "two" } })
      expect(storage.resolveEnv("myapp")).toEqual({ A: "one", B: "two" })

      storage.update("myapp", { secrets: { A: "rotated" } })
      expect(storage.resolveEnv("myapp")).toEqual({ A: "rotated", B: "two" })
    })

    test("promoting a plain env var to a secret drops the readable copy", () => {
      storage.create(createTestApp("myapp", { env: { API_TOKEN: "was-plaintext" } }))

      const updated = storage.update("myapp", { secrets: { API_TOKEN: "now-secret" } })!
      expect(updated.env.API_TOKEN).toBeUndefined()
      expect(appFile()).not.toContain("was-plaintext")
      expect(storage.resolveEnv("myapp")).toEqual({ API_TOKEN: "now-secret" })
    })

    test("create keeps a key out of env when it is also given as a secret", () => {
      const app = storage.create(
        createTestApp("myapp", { env: { API_TOKEN: "plain" }, secrets: { API_TOKEN: "secret" } })
      )
      expect(app.env.API_TOKEN).toBeUndefined()
      expect(storage.resolveEnv("myapp")).toEqual({ API_TOKEN: "secret" })
    })

    test("refuses to demote a secret back to a plain env var", () => {
      storage.create(createTestApp("myapp", { secrets: { API_TOKEN: "s3cr3t" } }))

      expect(() => storage.update("myapp", { env: { API_TOKEN: "oops" } })).toThrow("is a secret")
      expect(storage.resolveEnv("myapp")).toEqual({ API_TOKEN: "s3cr3t" })
    })

    test("unsetEnv removes secrets as well as plain env vars", () => {
      storage.create(createTestApp("myapp", { env: { NODE_ENV: "production" }, secrets: { API_TOKEN: "s3cr3t" } }))

      const updated = storage.update("myapp", { unsetEnv: ["API_TOKEN", "NODE_ENV"] })!
      expect(updated.secretKeys).toBeUndefined()
      expect(stored().secrets).toBeUndefined()
      expect(storage.resolveEnv("myapp")).toEqual({})

      // The key is free again afterwards
      expect(() => storage.update("myapp", { env: { API_TOKEN: "now-public" } })).not.toThrow()
    })

    test("unrelated updates preserve stored secrets", () => {
      storage.create(createTestApp("myapp", { secrets: { API_TOKEN: "s3cr3t" } }))

      storage.update("myapp", { status: "running", domains: ["a.example.com"] })
      expect(storage.resolveEnv("myapp")).toEqual({ API_TOKEN: "s3cr3t" })
    })

    test("ignores secretKeys sent back by a client", () => {
      storage.create(createTestApp("myapp", { secrets: { API_TOKEN: "s3cr3t" } }))

      const updated = storage.update("myapp", { secretKeys: ["INJECTED"] })!
      expect(updated.secretKeys).toEqual(["API_TOKEN"])
      expect(appFile()).not.toContain("INJECTED")
    })
  })
})
