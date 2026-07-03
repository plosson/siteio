// src/__tests__/unit/app-scaffold.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { scaffoldApp } from "../../lib/app-scaffold.ts"

describe("Unit: scaffoldApp", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "siteio-app-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  test("creates a starter Dockerfile", () => {
    scaffoldApp(dir)
    expect(existsSync(join(dir, "Dockerfile"))).toBe(true)
    const dockerfile = readFileSync(join(dir, "Dockerfile"), "utf-8")
    // The starter must be self-contained: inline builds have an empty context.
    expect(dockerfile).not.toMatch(/^\s*(COPY|ADD)\b/m)
    expect(dockerfile).toContain("EXPOSE")
  })

  test("does not overwrite an existing Dockerfile", () => {
    writeFileSync(join(dir, "Dockerfile"), "FROM scratch")
    scaffoldApp(dir)
    expect(readFileSync(join(dir, "Dockerfile"), "utf-8")).toBe("FROM scratch")
  })

  test("writes a CLAUDE.md guide covering app commands and capabilities", () => {
    scaffoldApp(dir)
    const guide = join(dir, "CLAUDE.md")
    expect(existsSync(guide)).toBe(true)
    const md = readFileSync(guide, "utf-8")
    // Covers the apps commands
    for (const cmd of ["siteio apps create", "siteio apps deploy", "siteio apps set", "siteio apps logs"]) {
      expect(md).toContain(cmd)
    }
    // Warns about the empty build context and covers the alternative sources
    expect(md).toContain("EMPTY build context")
    expect(md).toContain("--git")
    expect(md).toContain("--compose-file")
  })

  test("does not overwrite an existing CLAUDE.md", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "keep me")
    scaffoldApp(dir)
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toBe("keep me")
  })

  test("init command module loads", async () => {
    const mod = await import("../../commands/apps/init.ts")
    expect(typeof mod.appsInitCommand).toBe("function")
  })
})
