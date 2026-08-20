import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { unzipSync } from "fflate"
import {
  prepareWorkspace,
  collectWebFiles,
  buildDeployZip,
  hasWebChanges,
} from "../../lib/agent/chat/workspace.ts"

// Build a server code dir (deployed layout: public/**, pb_migrations/**, pb_hooks/**).
function makeCodeDir(): { codePath: string; cleanup: () => void } {
  const codePath = mkdtempSync(join(tmpdir(), "siteio-ws-code-"))
  mkdirSync(join(codePath, "public", "css"), { recursive: true })
  writeFileSync(join(codePath, "public", "index.html"), "<h1>Old</h1>")
  writeFileSync(join(codePath, "public", "css", "site.css"), "body{}")
  mkdirSync(join(codePath, "pb_migrations"), { recursive: true })
  writeFileSync(join(codePath, "pb_migrations", "1_init.js"), "// migration")
  mkdirSync(join(codePath, "pb_hooks"), { recursive: true })
  writeFileSync(join(codePath, "pb_hooks", "main.pb.js"), "// hook")
  return { codePath, cleanup: () => rmSync(codePath, { recursive: true, force: true }) }
}

describe("Unit: chat workspace", () => {
  let codePath: string
  let cleanupCode: () => void
  let ws: string

  beforeEach(() => {
    const c = makeCodeDir()
    codePath = c.codePath
    cleanupCode = c.cleanup
    ws = mkdtempSync(join(tmpdir(), "siteio-ws-work-")) + "/wsdir"
  })
  afterEach(() => {
    cleanupCode()
    rmSync(join(ws, ".."), { recursive: true, force: true })
  })

  test("prepareWorkspace materializes the web root flat (no public/ prefix, no backend)", () => {
    prepareWorkspace(codePath, ws)
    expect(existsSync(join(ws, "index.html"))).toBe(true)
    expect(existsSync(join(ws, "css", "site.css"))).toBe(true)
    // Backend dirs are NOT copied into the workspace.
    expect(existsSync(join(ws, "pb_migrations"))).toBe(false)
    expect(existsSync(join(ws, "pb_hooks"))).toBe(false)
    // The public/ prefix is stripped at the workspace root.
    expect(existsSync(join(ws, "public"))).toBe(false)
  })

  test("collectWebFiles maps root files back to public/ and skips symlinks", () => {
    prepareWorkspace(codePath, ws)
    // Agent edits a file...
    writeFileSync(join(ws, "index.html"), "<h1>New</h1>")
    // ...and plants a symlink to a host secret (the exfiltration attack).
    symlinkSync("/etc/hostname", join(ws, "leak.txt"))

    const collected = collectWebFiles(ws)
    expect(Object.keys(collected).sort()).toEqual(["public/css/site.css", "public/index.html"])
    // The symlink is not followed / not collected.
    expect(collected["public/leak.txt"]).toBeUndefined()
    expect(new TextDecoder().decode(collected["public/index.html"])).toBe("<h1>New</h1>")
  })

  test("prepareWorkspace does not follow symlinks in the source", () => {
    // A malicious symlink already in the code dir must not be copied through.
    symlinkSync("/etc/hostname", join(codePath, "public", "evil.txt"))
    prepareWorkspace(codePath, ws)
    expect(existsSync(join(ws, "evil.txt"))).toBe(false)
  })

  test("buildDeployZip preserves backend and re-prefixes web files", () => {
    prepareWorkspace(codePath, ws)
    writeFileSync(join(ws, "index.html"), "<h1>New</h1>")
    const zip = unzipSync(buildDeployZip(ws, codePath))
    // Web files under public/, backend preserved from current code.
    expect(new TextDecoder().decode(zip["public/index.html"])).toBe("<h1>New</h1>")
    expect(zip["pb_migrations/1_init.js"]).toBeDefined()
    expect(zip["pb_hooks/main.pb.js"]).toBeDefined()
  })

  test("hasWebChanges detects edits, additions, and reports no change on a clean copy", () => {
    prepareWorkspace(codePath, ws)
    expect(hasWebChanges(ws, codePath)).toEqual({ changed: false, changedFiles: [] })

    writeFileSync(join(ws, "index.html"), "<h1>New</h1>")
    writeFileSync(join(ws, "about.html"), "<p>new page</p>")
    const res = hasWebChanges(ws, codePath)
    expect(res.changed).toBe(true)
    expect(res.changedFiles).toEqual(["about.html", "index.html"])
  })

  test("a symlink edit does not count as a real change (anti-exfiltration)", () => {
    prepareWorkspace(codePath, ws)
    symlinkSync("/etc/hostname", join(ws, "index.html.link"))
    expect(hasWebChanges(ws, codePath)).toEqual({ changed: false, changedFiles: [] })
  })
})
