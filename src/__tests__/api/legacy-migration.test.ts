import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import { hasLegacySites } from "../../lib/agent/legacy-migration.ts"
import { POCKETBASE_IMAGE } from "../../lib/pocketbase-version.ts"
import type { AgentConfig, ApiResponse, SiteInfo, SiteVersion } from "../../types.ts"

function makeServer(dataDir: string, runtime: FakeRuntime): AgentServer {
  const config: AgentConfig = {
    apiKey: "test-key", dataDir, domain: "example.com",
    maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
  }
  return new AgentServer(config, runtime)
}

// Lay down a pre-merge data dir: shared-nginx site files + metadata + history.
function writeLegacySite(
  dataDir: string,
  name: string,
  opts: { domains?: string[]; oauth?: object; persistentStorage?: boolean; version?: number; history?: Record<number, string> } = {}
): void {
  mkdirSync(join(dataDir, "sites", name), { recursive: true })
  writeFileSync(join(dataDir, "sites", name, "index.html"), `<h1>${name}</h1>`)
  mkdirSync(join(dataDir, "metadata"), { recursive: true })
  writeFileSync(
    join(dataDir, "metadata", `${name}.json`),
    JSON.stringify({
      subdomain: name,
      domains: opts.domains,
      size: 42,
      version: opts.version ?? 3,
      deployedAt: "2026-01-01T00:00:00.000Z",
      deployedBy: "ada",
      files: ["index.html"],
      oauth: opts.oauth,
      persistentStorage: opts.persistentStorage,
    })
  )
  for (const [v, content] of Object.entries(opts.history ?? {})) {
    const vDir = join(dataDir, "history", name, `v${v}`)
    mkdirSync(vDir, { recursive: true })
    writeFileSync(join(vDir, "index.html"), content)
    writeFileSync(
      join(dataDir, "history", name, `v${v}.json`),
      JSON.stringify({ version: Number(v), deployedAt: "2025-12-01T00:00:00.000Z", size: content.length } satisfies SiteVersion)
    )
  }
}

describe("Legacy static-site migration", () => {
  let dataDir: string
  let runtime: FakeRuntime
  let server: AgentServer

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-migration-"))
    runtime = new FakeRuntime()
    server = makeServer(dataDir, runtime)
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  test("migrates a legacy site into the container layout and starts it", async () => {
    writeLegacySite(dataDir, "blog", { domains: ["blog.custom.org"], history: { 1: "old-v1", 2: "old-v2" } })

    await server.migrateLegacy()

    // Web root moved under public/, backend dirs created
    const code = join(dataDir, "pocket-code", "blog")
    expect(readFileSync(join(code, "public", "index.html"), "utf-8")).toBe("<h1>blog</h1>")
    expect(existsSync(join(code, "pb_migrations"))).toBe(true)

    // History carried over, each version wrapped under public/
    expect(readFileSync(join(dataDir, "pocket-history", "blog", "v1", "public", "index.html"), "utf-8")).toBe("old-v1")
    expect(existsSync(join(dataDir, "pocket-history", "blog", "v1.json"))).toBe(true)

    // Image pulled once, container started, legacy routing containers removed
    expect(runtime.callsOf("pull").map((c) => c.args[0])).toEqual([POCKETBASE_IMAGE])
    const runCall = runtime.callsOf("run")[0]!.args[0] as { name: string; volumes: { name: string }[] }
    expect(runCall.name).toBe("blog")

    // Legacy dirs moved to backup, originals preserved
    expect(existsSync(join(dataDir, "sites"))).toBe(false)
    expect(existsSync(join(dataDir, "metadata"))).toBe(false)
    expect(readFileSync(join(dataDir, "legacy-backup", "sites", "blog", "index.html"), "utf-8")).toBe("<h1>blog</h1>")

    // The site is fully live via the API, custom domains intact
    const res = await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "GET", headers: { "X-API-Key": "test-key" } }))
    const body = (await res.json()) as ApiResponse<SiteInfo>
    expect(body.data!.status).toBe("running")
    expect(body.data!.domains).toEqual(["blog.custom.org"])
    expect(body.data!.url).toBe("https://blog.example.com")

    // History is queryable through the new endpoint
    const hist = await server.handleRequestForTest(new Request("http://x/sites/blog/history", { method: "GET", headers: { "X-API-Key": "test-key" } }))
    const histBody = (await hist.json()) as ApiResponse<SiteVersion[]>
    expect(histBody.data!.map((v) => v.version)).toEqual([2, 1])
  })

  test("is idempotent — second run is a no-op", async () => {
    writeLegacySite(dataDir, "blog")
    await server.migrateLegacy()
    expect(hasLegacySites(dataDir)).toBe(false)

    runtime.calls = []
    await server.migrateLegacy()
    expect(runtime.calls).toHaveLength(0)
  })

  test("skips a legacy site whose name collides with an existing site", async () => {
    // An existing (post-merge) site named "blog"
    const { zipSync } = await import("fflate")
    await server.handleRequestForTest(
      new Request("http://x/sites/blog", {
        method: "POST",
        headers: { "X-API-Key": "test-key", "Content-Type": "application/zip" },
        body: zipSync({ "public/index.html": new TextEncoder().encode("new") }),
      })
    )
    writeLegacySite(dataDir, "blog")
    writeLegacySite(dataDir, "shop")

    await server.migrateLegacy()

    // Existing site untouched, legacy blog preserved in backup, shop migrated
    expect(readFileSync(join(dataDir, "pocket-code", "blog", "public", "index.html"), "utf-8")).toBe("new")
    expect(existsSync(join(dataDir, "legacy-backup", "sites", "blog"))).toBe(true)
    expect(readFileSync(join(dataDir, "pocket-code", "shop", "public", "index.html"), "utf-8")).toBe("<h1>shop</h1>")
  })

  test("drops oauth and persistent storage with the data preserved in backup", async () => {
    writeLegacySite(dataDir, "secret", { oauth: { allowedEmails: ["a@b.co"] }, persistentStorage: true })
    mkdirSync(join(dataDir, "persistent-storage", "secret"), { recursive: true })
    writeFileSync(join(dataDir, "persistent-storage", "secret", "_anonymous.json"), "{}")

    const logs: string[] = []
    const origLog = console.log
    console.log = (m: string) => logs.push(String(m))
    try {
      await server.migrateLegacy()
    } finally {
      console.log = origLog
    }

    expect(logs.join("\n")).toContain("OAuth protection was dropped")
    expect(logs.join("\n")).toContain("persistent-localStorage was dropped")
    expect(existsSync(join(dataDir, "legacy-backup", "persistent-storage", "secret", "_anonymous.json"))).toBe(true)
  })

  test("does not start containers when Docker is unavailable but still migrates files", async () => {
    writeLegacySite(dataDir, "blog")
    runtime.isAvailableReturn = false

    await server.migrateLegacy()

    expect(existsSync(join(dataDir, "pocket-code", "blog", "public", "index.html"))).toBe(true)
    expect(runtime.callsOf("run")).toHaveLength(0)
    // Metadata exists with pending status; next deploy will start it
    const res = await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "GET", headers: { "X-API-Key": "test-key" } }))
    const body = (await res.json()) as ApiResponse<SiteInfo>
    expect(body.data!.status).toBe("pending")
  })
})
