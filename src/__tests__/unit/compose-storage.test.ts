import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { ComposeStorage } from "../../lib/agent/compose-storage"

describe("Unit: ComposeStorage", () => {
  let testDir: string
  let storage: ComposeStorage

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "siteio-compose-test-"))
    storage = new ComposeStorage(testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test("writeBaseInline persists compose file under dataDir/compose/<app>/docker-compose.yml", () => {
    storage.writeBaseInline("myapp", "services:\n  web:\n    image: nginx\n")
    const expected = join(testDir, "compose", "myapp", "docker-compose.yml")
    expect(existsSync(expected)).toBe(true)
    expect(readFileSync(expected, "utf-8")).toContain("image: nginx")
  })

  test("baseInlinePath returns the expected location", () => {
    expect(storage.baseInlinePath("myapp")).toBe(
      join(testDir, "compose", "myapp", "docker-compose.yml")
    )
  })

  test("overridePath returns the expected location", () => {
    expect(storage.overridePath("myapp")).toBe(
      join(testDir, "compose", "myapp", "docker-compose.siteio.yml")
    )
  })

  test("writeOverride persists override alongside the base file", () => {
    storage.writeBaseInline("myapp", "services: {}")
    storage.writeOverride("myapp", "networks:\n  siteio-network:\n    external: true\n")
    expect(existsSync(storage.overridePath("myapp"))).toBe(true)
  })

  test("writeOverride creates dir even when no base file exists (git-hosted apps)", () => {
    storage.writeOverride("gitapp", "services: {}")
    expect(existsSync(storage.overridePath("gitapp"))).toBe(true)
  })

  test("exists returns true when inline base file is present", () => {
    expect(storage.exists("x")).toBe(false)
    storage.writeBaseInline("x", "services: {}")
    expect(storage.exists("x")).toBe(true)
  })

  test("remove deletes the app's compose directory", () => {
    storage.writeBaseInline("myapp", "services: {}")
    storage.writeOverride("myapp", "services: {}")
    storage.remove("myapp")
    expect(existsSync(join(testDir, "compose", "myapp"))).toBe(false)
  })

  test("writeBaseEnv persists .env file alongside compose file", () => {
    storage.writeBaseEnv("myapp", "POSTGRES_PASSWORD=secret\nFOO=bar\n")
    const expected = join(testDir, "compose", "myapp", ".env")
    expect(existsSync(expected)).toBe(true)
    expect(readFileSync(expected, "utf-8")).toContain("POSTGRES_PASSWORD=secret")
  })

  test("baseEnvPath returns the expected location", () => {
    expect(storage.baseEnvPath("myapp")).toBe(
      join(testDir, "compose", "myapp", ".env")
    )
  })

  test("envFileExists is false before write, true after", () => {
    expect(storage.envFileExists("x")).toBe(false)
    storage.writeBaseEnv("x", "KEY=value")
    expect(storage.envFileExists("x")).toBe(true)
  })

  test("remove deletes the .env alongside the compose files", () => {
    storage.writeBaseInline("myapp", "services: {}")
    storage.writeBaseEnv("myapp", "KEY=v")
    storage.remove("myapp")
    expect(existsSync(join(testDir, "compose", "myapp", ".env"))).toBe(false)
  })
})
