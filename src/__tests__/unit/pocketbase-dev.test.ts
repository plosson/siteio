import { describe, test, expect } from "bun:test"
import { buildDevArgs, resolveDevPaths } from "../../lib/pocketbase-dev.ts"

describe("Unit: pocketbase dev runner", () => {
  test("builds serve args with all dirs and http bind", () => {
    const args = buildDevArgs({
      publicDir: "/proj",
      migrationsDir: "/proj/.siteio/pb_migrations",
      hooksDir: "/proj/.siteio/pb_hooks",
      dataDir: "/proj/.siteio/pb_data",
      http: "127.0.0.1:8090",
    })
    expect(args).toEqual([
      "serve",
      "--http=127.0.0.1:8090",
      "--dir=/proj/.siteio/pb_data",
      "--publicDir=/proj",
      "--migrationsDir=/proj/.siteio/pb_migrations",
      "--hooksDir=/proj/.siteio/pb_hooks",
    ])
  })

  test("resolves the .siteio plumbing paths under a folder", () => {
    const p = resolveDevPaths("/proj")
    expect(p.publicDir).toBe("/proj")
    expect(p.migrationsDir).toBe("/proj/.siteio/pb_migrations")
    expect(p.hooksDir).toBe("/proj/.siteio/pb_hooks")
    expect(p.dataDir).toBe("/proj/.siteio/pb_data")
  })
})
