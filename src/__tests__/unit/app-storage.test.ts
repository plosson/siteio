import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
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
    test("marks the keys it was given as secret", () => {
      storage.create(createTestApp("myapp", { env: { NODE_ENV: "production" } }))

      const updated = storage.update("myapp", { secrets: { API_TOKEN: "s3cr3t" } })!
      expect(updated.env).toEqual({ NODE_ENV: "production", API_TOKEN: "s3cr3t" })
      expect(updated.secretKeys).toEqual(["API_TOKEN"])
    })

    test("adds and rotates secrets across updates", () => {
      storage.create(createTestApp("myapp"))

      storage.update("myapp", { secrets: { A: "one" } })
      const updated = storage.update("myapp", { secrets: { B: "two" } })!
      expect(updated.env).toEqual({ A: "one", B: "two" })
      expect(updated.secretKeys?.sort()).toEqual(["A", "B"])

      const rotated = storage.update("myapp", { secrets: { A: "rotated" } })!
      expect(rotated.env.A).toBe("rotated")
      expect(rotated.secretKeys?.sort()).toEqual(["A", "B"])
    })

    test("marking an existing plain env var secret keeps its key listed once", () => {
      storage.create(createTestApp("myapp", { env: { API_TOKEN: "was-plain" } }))

      const updated = storage.update("myapp", { secrets: { API_TOKEN: "now-secret" } })!
      expect(updated.env.API_TOKEN).toBe("now-secret")
      expect(updated.secretKeys).toEqual(["API_TOKEN"])
    })

    test("refuses to un-secret a key with a plain -e", () => {
      storage.create(createTestApp("myapp"))
      storage.update("myapp", { secrets: { API_TOKEN: "s3cr3t" } })

      expect(() => storage.update("myapp", { env: { API_TOKEN: "oops" } })).toThrow("is a secret")
      expect(storage.get("myapp")!.env.API_TOKEN).toBe("s3cr3t")
    })

    test("unsetEnv removes the value and the secret marking", () => {
      storage.create(createTestApp("myapp", { env: { NODE_ENV: "production" } }))
      storage.update("myapp", { secrets: { API_TOKEN: "s3cr3t" } })

      const updated = storage.update("myapp", { unsetEnv: ["API_TOKEN"] })!
      expect(updated.env).toEqual({ NODE_ENV: "production" })
      expect(updated.secretKeys).toBeUndefined()

      // The key is free to use as plain config again
      expect(() => storage.update("myapp", { env: { API_TOKEN: "now-public" } })).not.toThrow()
    })

    test("unrelated updates preserve the secret marking", () => {
      storage.create(createTestApp("myapp"))
      storage.update("myapp", { secrets: { API_TOKEN: "s3cr3t" } })

      const updated = storage.update("myapp", { status: "running", domains: ["a.example.com"] })!
      expect(updated.secretKeys).toEqual(["API_TOKEN"])
      expect(updated.env.API_TOKEN).toBe("s3cr3t")
    })

    test("derives secretKeys rather than trusting what a client sends", () => {
      storage.create(createTestApp("myapp"))
      storage.update("myapp", { secrets: { API_TOKEN: "s3cr3t" } })

      const updated = storage.update("myapp", { secretKeys: ["INJECTED"] })!
      expect(updated.secretKeys).toEqual(["API_TOKEN"])
    })
  })
})
