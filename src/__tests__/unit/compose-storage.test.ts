import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "fs"
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

  describe("writeSiteioEnv", () => {
    const vars = { SITEIO_APP: "myapp", SITEIO_URL: "https://myapp.example.com" }

    test("writes siteio vars then the user's file, so user values win", () => {
      storage.writeBaseEnv("myapp", "SITEIO_URL=https://mine.test\nDB=x\n")
      const path = storage.writeSiteioEnv("myapp", vars, storage.baseEnvPath("myapp"))
      expect(path).toBe(join(testDir, "compose", "myapp", "siteio.env"))
      const lines = readFileSync(path, "utf-8").split("\n")
      expect(lines.indexOf("SITEIO_URL=https://myapp.example.com")).toBeLessThan(lines.indexOf("SITEIO_URL=https://mine.test"))
      expect(lines).toContain("DB=x")
    })

    test("a user env path that does not exist is skipped, not an error", () => {
      const path = storage.writeSiteioEnv("myapp", vars, join(testDir, "nope", ".env"))
      expect(readFileSync(path, "utf-8")).toContain("SITEIO_APP=myapp")
    })

    test("creates the app folder when it does not exist yet", () => {
      const path = storage.writeSiteioEnv("fresh", vars)
      expect(existsSync(path)).toBe(true)
    })

    test("does not rewrite an unchanged file, rewrites a changed one", () => {
      const path = storage.writeSiteioEnv("myapp", vars)
      const past = new Date(Date.now() - 60_000)
      utimesSync(path, past, past)
      storage.writeSiteioEnv("myapp", vars)
      expect(statSync(path).mtimeMs).toBe(past.getTime())

      storage.writeSiteioEnv("myapp", { ...vars, SITEIO_URL: "https://other.test" })
      expect(statSync(path).mtimeMs).toBeGreaterThan(past.getTime())
      expect(readFileSync(path, "utf-8")).toContain("SITEIO_URL=https://other.test")
    })

    test("a user file without a trailing newline does not merge into the last siteio line", () => {
      writeFileSync(join(testDir, "user.env"), "A=1")
      const path = storage.writeSiteioEnv("myapp", vars, join(testDir, "user.env"))
      expect(readFileSync(path, "utf-8").split("\n")).toContain("A=1")
      expect(readFileSync(path, "utf-8")).toContain("SITEIO_URL=https://myapp.example.com\n")
    })

    test("remove() deletes it with the rest of the app folder", () => {
      const path = storage.writeSiteioEnv("myapp", vars)
      storage.remove("myapp")
      expect(existsSync(path)).toBe(false)
    })
  })
})
