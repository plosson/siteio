import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AppStorage } from "../lib/agent/app-storage"
import type { App, AppType, ContainerStatus, RestartPolicy } from "../types"

describe("AppStorage", () => {
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
})
