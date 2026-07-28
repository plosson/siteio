import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { mergeScopedDeploy } from "../../lib/agent/deploy-merge.ts"

describe("Unit: mergeScopedDeploy", () => {
  let codePath: string
  const enc = (s: string) => new TextEncoder().encode(s)
  const dec = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : undefined)

  beforeEach(() => {
    // Current site code: web + backend on disk.
    codePath = mkdtempSync(join(tmpdir(), "siteio-merge-"))
    mkdirSync(join(codePath, "public"), { recursive: true })
    mkdirSync(join(codePath, "pb_migrations"), { recursive: true })
    mkdirSync(join(codePath, "pb_hooks"), { recursive: true })
    writeFileSync(join(codePath, "public", "index.html"), "<h1>current</h1>")
    writeFileSync(join(codePath, "pb_migrations", "1_init.js"), "// current migration")
    writeFileSync(join(codePath, "pb_hooks", "main.pb.js"), "// current hook")
  })
  afterEach(() => rmSync(codePath, { recursive: true, force: true }))

  test("web root comes from incoming; backend preserved when allowBackend is false", () => {
    const incoming = {
      "public/index.html": enc("<h1>invitee</h1>"),
      // Even a smuggled-in migration is ignored when allowBackend is false.
      "pb_migrations/9_evil.js": enc("DROP EVERYTHING"),
    }
    const out = mergeScopedDeploy({ incoming, currentCodePath: codePath, allowBackend: false })
    expect(dec(out["public/index.html"])).toBe("<h1>invitee</h1>")
    expect(dec(out["pb_migrations/1_init.js"])).toBe("// current migration")
    expect(dec(out["pb_hooks/main.pb.js"])).toBe("// current hook")
    expect(out["pb_migrations/9_evil.js"]).toBeUndefined()
  })

  test("allowBackend uses the incoming backend dir when supplied", () => {
    const incoming = {
      "public/index.html": enc("<h1>invitee</h1>"),
      "pb_migrations/2_add.js": enc("// new migration"),
    }
    const out = mergeScopedDeploy({ incoming, currentCodePath: codePath, allowBackend: true })
    // Supplied dir (migrations) replaced wholesale by incoming...
    expect(dec(out["pb_migrations/2_add.js"])).toBe("// new migration")
    expect(out["pb_migrations/1_init.js"]).toBeUndefined()
    // ...but a dir the invitee omitted (hooks) is still preserved.
    expect(dec(out["pb_hooks/main.pb.js"])).toBe("// current hook")
  })

  test("allowBackend but no incoming backend at all -> current backend preserved (safe)", () => {
    const incoming = { "public/index.html": enc("<h1>invitee</h1>") }
    const out = mergeScopedDeploy({ incoming, currentCodePath: codePath, allowBackend: true })
    expect(dec(out["pb_migrations/1_init.js"])).toBe("// current migration")
    expect(dec(out["pb_hooks/main.pb.js"])).toBe("// current hook")
  })

  test("non-public incoming keys are dropped from the web root", () => {
    const incoming = {
      "public/app.js": enc("ok"),
      "random.txt": enc("nope"),
      "../escape": enc("nope"),
    }
    const out = mergeScopedDeploy({ incoming, currentCodePath: codePath, allowBackend: false })
    expect(dec(out["public/app.js"])).toBe("ok")
    expect(out["random.txt"]).toBeUndefined()
    expect(out["../escape"]).toBeUndefined()
  })
})
