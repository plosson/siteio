// src/__tests__/api/pockets.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import { POCKETBASE_VERSION, pocketbaseImage } from "../../lib/pocketbase-version.ts"
import type { AgentConfig, ApiResponse, SiteInfo } from "../../types.ts"

function makeServer(dataDir: string, runtime: FakeRuntime): AgentServer {
  const config: AgentConfig = {
    apiKey: "test-key", dataDir, domain: "example.com",
    maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
  }
  return new AgentServer(config, runtime)
}

const H = { "X-API-Key": "test-key", "Content-Type": "application/zip" }

describe("API: sites", () => {
  let dataDir: string
  let runtime: FakeRuntime
  let server: AgentServer

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-pockets-"))
    runtime = new FakeRuntime()
    server = makeServer(dataDir, runtime)
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  const zip = () => zipSync({ "public/index.html": new TextEncoder().encode("<h1>hi</h1>") })

  test("POST /sites/:name deploys a new site using the pinned image", async () => {
    const res = await server.handleRequestForTest(
      new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiResponse<SiteInfo>
    expect(body.success).toBe(true)
    expect(body.data!.url).toBe("https://blog.example.com")
    expect(body.data!.status).toBe("running")

    const runCall = runtime.calls.find((c) => c.method === "run")
    expect(runCall).toBeDefined()
    const runConfig = runCall!.args[0] as { labels: Record<string, string> }
    expect(runConfig.labels["traefik.http.routers.siteio-blog.middlewares"]).toBe("siteio-blog-cache")
    expect(
      runConfig.labels[
        "traefik.http.middlewares.siteio-blog-cache.headers.customresponseheaders.Cache-Control"
      ]
    ).toBe("no-cache, max-age=0, must-revalidate")
    expect(
      runConfig.labels["traefik.http.middlewares.siteio-blog-cache.headers.customresponseheaders.Pragma"]
    ).toBe("no-cache")
    expect(
      runConfig.labels["traefik.http.middlewares.siteio-blog-cache.headers.customresponseheaders.Expires"]
    ).toBe("0")
    const pullCall = runtime.calls.find((c) => c.method === "pull")
    expect(pullCall!.args[0]).toBe(pocketbaseImage())
  })

  test("GET /sites lists deployed sites", async () => {
    await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() }))
    const res = await server.handleRequestForTest(new Request("http://x/sites", { method: "GET", headers: { "X-API-Key": "test-key" } }))
    const body = (await res.json()) as ApiResponse<SiteInfo[]>
    expect(body.data).toHaveLength(1)
    expect(body.data?.[0]?.name).toBe("blog")
  })

  test("GET /sites/:name/admin returns generated superuser credentials", async () => {
    await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() }))
    const res = await server.handleRequestForTest(new Request("http://x/sites/blog/admin", { method: "GET", headers: { "X-API-Key": "test-key" } }))
    const body = (await res.json()) as ApiResponse<{ email: string; password: string; adminUrl: string }>
    expect(body.data!.email).toContain("@")
    expect(body.data!.password.length).toBeGreaterThan(8)
    expect(body.data!.adminUrl).toBe("https://blog.example.com/_/")
  })

  test("POST /sites/:name returns 500 and creates nothing when Docker is unavailable", async () => {
    runtime.isAvailableReturn = false
    const res = await server.handleRequestForTest(
      new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() })
    )
    expect(res.status).toBe(500)
    const list = await server.handleRequestForTest(new Request("http://x/sites", { method: "GET", headers: { "X-API-Key": "test-key" } }))
    const body = (await list.json()) as ApiResponse<SiteInfo[]>
    expect(body.data).toHaveLength(0)
  })

  test("pocketbaseVersion is always POCKETBASE_VERSION even when client sends a different X-Site-Version", async () => {
    const headers = { ...H, "X-Site-Version": "0.0.1-custom" }
    const res = await server.handleRequestForTest(
      new Request("http://x/sites/blog", { method: "POST", headers, body: zip() })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiResponse<SiteInfo>
    expect(body.data!.pocketbaseVersion).toBe(POCKETBASE_VERSION)
  })

  test("redeploy keeps a site on its own PocketBase version instead of silently moving it to the pin", async () => {
    await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() }))
    // Simulate a site created by an older agent: pinned to a version other than the current default.
    const metaPath = join(dataDir, "pockets", "blog.json")
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"))
    writeFileSync(metaPath, JSON.stringify({ ...meta, pocketbaseVersion: "0.1.0" }))
    runtime.calls = []

    const res = await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiResponse<SiteInfo>
    expect(body.data!.pocketbaseVersion).toBe("0.1.0")
    expect(runtime.calls.filter((c) => c.method === "pull").map((c) => c.args[0])).toEqual([pocketbaseImage("0.1.0")])
    const runConfig = runtime.calls.find((c) => c.method === "run")!.args[0] as { image: string }
    expect(runConfig.image).toBe(pocketbaseImage("0.1.0"))
  })

  test("GET /sites/:name/download returns the deployed code as a zip", async () => {
    await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() }))
    const res = await server.handleRequestForTest(
      new Request("http://x/sites/blog/download", { method: "GET", headers: { "X-API-Key": "test-key" } })
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("application/zip")
    expect(res.headers.get("Content-Disposition")).toContain("blog.zip")
    const { unzipSync } = await import("fflate")
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()))
    expect(Object.keys(files)).toContain("public/index.html")
    expect(new TextDecoder().decode(files["public/index.html"]!)).toBe("<h1>hi</h1>")
  })

  test("GET /sites/:name/download returns 404 for a missing site", async () => {
    const res = await server.handleRequestForTest(
      new Request("http://x/sites/nope/download", { method: "GET", headers: { "X-API-Key": "test-key" } })
    )
    expect(res.status).toBe(404)
  })

  describe("Version conflict detection", () => {
    const deploy = (expectedVersion?: number) => {
      const headers: Record<string, string> = { ...H }
      if (expectedVersion !== undefined) headers["X-Expected-Version"] = String(expectedVersion)
      return server.handleRequestForTest(
        new Request("http://x/sites/blog", { method: "POST", headers, body: zip() })
      )
    }

    test("deploy returns a version that increments on redeploy", async () => {
      const first = (await (await deploy()).json()) as ApiResponse<SiteInfo>
      expect(first.data!.version).toBeGreaterThanOrEqual(1)
      const second = (await (await deploy()).json()) as ApiResponse<SiteInfo>
      expect(second.data!.version).toBe(first.data!.version! + 1)
    })

    test("should allow deploy when expected version matches", async () => {
      const first = (await (await deploy()).json()) as ApiResponse<SiteInfo>
      const res = await deploy(first.data!.version!)
      expect(res.status).toBe(200)
      const body = (await res.json()) as ApiResponse<SiteInfo>
      expect(body.data!.version).toBe(first.data!.version! + 1)
    })

    test("should reject deploy when expected version does not match", async () => {
      const first = (await (await deploy()).json()) as ApiResponse<SiteInfo>
      await deploy() // version incremented by someone else
      const res = await deploy(first.data!.version!)
      expect(res.status).toBe(409)
      const body = (await res.json()) as ApiResponse<null>
      expect(body.error).toContain("Version conflict")
    })
  })

  describe("History and rollback", () => {
    const deployContent = (html: string) =>
      server.handleRequestForTest(
        new Request("http://x/sites/blog", {
          method: "POST", headers: H,
          body: zipSync({ "public/index.html": new TextEncoder().encode(html) }),
        })
      )

    test("GET /sites/:name/history lists archived versions newest first", async () => {
      await deployContent("v1")
      await deployContent("v2")
      await deployContent("v3")
      const res = await server.handleRequestForTest(
        new Request("http://x/sites/blog/history", { method: "GET", headers: { "X-API-Key": "test-key" } })
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as ApiResponse<{ version: number; deployedAt: string }[]>
      expect(body.data!.map((v) => v.version)).toEqual([2, 1])
      expect(body.data![0]!.deployedAt).toBeTruthy()
    })

    test("GET /sites/:name/history returns 404 for a missing site", async () => {
      const res = await server.handleRequestForTest(
        new Request("http://x/sites/nope/history", { method: "GET", headers: { "X-API-Key": "test-key" } })
      )
      expect(res.status).toBe(404)
    })

    test("POST /sites/:name/rollback restores archived code and recreates the container", async () => {
      await deployContent("v1")
      await deployContent("v2")
      runtime.containerExistsReturn = true
      runtime.calls = []

      const res = await server.handleRequestForTest(
        new Request("http://x/sites/blog/rollback", {
          method: "POST",
          headers: { "X-API-Key": "test-key", "Content-Type": "application/json" },
          body: JSON.stringify({ version: 1 }),
        })
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as ApiResponse<SiteInfo>
      expect(body.data!.version).toBe(3)

      // Container recreated (mount inode changed after code restore)
      expect(runtime.callsOf("remove")).toHaveLength(1)
      expect(runtime.callsOf("run")).toHaveLength(1)

      // The live code is v1's content again
      const dl = await server.handleRequestForTest(
        new Request("http://x/sites/blog/download", { method: "GET", headers: { "X-API-Key": "test-key" } })
      )
      const { unzipSync } = await import("fflate")
      const files = unzipSync(new Uint8Array(await dl.arrayBuffer()))
      expect(new TextDecoder().decode(files["public/index.html"]!)).toBe("v1")
    })

    test("POST rollback to a nonexistent version returns 404", async () => {
      await deployContent("v1")
      const res = await server.handleRequestForTest(
        new Request("http://x/sites/blog/rollback", {
          method: "POST",
          headers: { "X-API-Key": "test-key", "Content-Type": "application/json" },
          body: JSON.stringify({ version: 99 }),
        })
      )
      expect(res.status).toBe(404)
    })
  })

  describe("Custom domains", () => {
    const patchDomains = (domains: unknown, name = "blog") =>
      server.handleRequestForTest(
        new Request(`http://x/sites/${name}/domains`, {
          method: "PATCH",
          headers: { "X-API-Key": "test-key", "Content-Type": "application/json" },
          body: JSON.stringify({ domains }),
        })
      )

    test("PATCH /sites/:name/domains sets custom domains and recreates the container with new labels", async () => {
      await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() }))
      runtime.containerExistsReturn = true
      runtime.calls = []

      const res = await patchDomains(["www.custom.org", "custom.org"])
      expect(res.status).toBe(200)
      const body = (await res.json()) as ApiResponse<SiteInfo>
      expect(body.data!.domains).toEqual(["www.custom.org", "custom.org"])
      expect(body.data!.url).toBe("https://blog.example.com")

      // The main router serves the custom domains only; the platform subdomain
      // gets its own router so it can be de-indexed.
      const labelCall = runtime.callsOf("buildTraefikLabels")[0]!
      expect(labelCall.args[1]).toEqual(["www.custom.org", "custom.org"])

      const labels = (runtime.callsOf("run")[0]!.args[0] as { labels: Record<string, string> }).labels
      expect(labels["traefik.http.routers.siteio-blog.rule"]).toBe(
        "Host(`www.custom.org`) || Host(`custom.org`)"
      )
      expect(labels["traefik.http.routers.siteio-blog-canonical.rule"]).toBe("Host(`blog.example.com`)")
      expect(labels["traefik.http.routers.siteio-blog-canonical.service"]).toBe("siteio-blog")
      expect(
        labels["traefik.http.middlewares.siteio-blog-noindex.headers.customresponseheaders.X-Robots-Tag"]
      ).toBe("noindex, nofollow")
      // The subdomain keeps the no-cache headers the main router has.
      expect(labels["traefik.http.routers.siteio-blog-canonical.middlewares"]).toBe(
        "siteio-blog-cache,siteio-blog-noindex"
      )
    })

    test("a site with no custom domain keeps a single router on the platform subdomain", async () => {
      runtime.calls = []
      await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() }))

      const labels = (runtime.callsOf("run")[0]!.args[0] as { labels: Record<string, string> }).labels
      expect(labels["traefik.http.routers.siteio-blog.rule"]).toBe("Host(`blog.example.com`)")
      expect(labels["traefik.http.routers.siteio-blog-canonical.rule"]).toBeUndefined()
      expect(
        labels["traefik.http.middlewares.siteio-blog-noindex.headers.customresponseheaders.X-Robots-Tag"]
      ).toBeUndefined()
    })

    test("removing the last custom domain hands the platform subdomain back to the main router", async () => {
      await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() }))
      runtime.containerExistsReturn = true
      await patchDomains(["custom.org"])
      runtime.calls = []

      const res = await patchDomains([])
      expect(res.status).toBe(200)

      const labels = (runtime.callsOf("run")[0]!.args[0] as { labels: Record<string, string> }).labels
      expect(labels["traefik.http.routers.siteio-blog.rule"]).toBe("Host(`blog.example.com`)")
      expect(labels["traefik.http.routers.siteio-blog-canonical.rule"]).toBeUndefined()
    })

    test("rejects domains under the base domain", async () => {
      await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() }))
      const res = await patchDomains(["other.example.com"])
      expect(res.status).toBe(400)
    })

    test("rejects a domain already used by another pocket", async () => {
      await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() }))
      await server.handleRequestForTest(new Request("http://x/sites/shop", { method: "POST", headers: H, body: zip() }))
      await patchDomains(["custom.org"], "blog")
      const res = await patchDomains(["custom.org"], "shop")
      expect(res.status).toBe(400)
      const body = (await res.json()) as ApiResponse<null>
      expect(body.error).toContain("already in use")
    })

    test("rejects an invalid domain format", async () => {
      await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() }))
      const res = await patchDomains(["not a domain"])
      expect(res.status).toBe(400)
    })
  })

  describe("Rename", () => {
    test("PATCH /sites/:name/rename moves everything to the new name", async () => {
      await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() }))
      runtime.containerExistsReturn = true
      runtime.calls = []

      const res = await server.handleRequestForTest(
        new Request("http://x/sites/blog/rename", {
          method: "PATCH",
          headers: { "X-API-Key": "test-key", "Content-Type": "application/json" },
          body: JSON.stringify({ newSubdomain: "journal" }),
        })
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as ApiResponse<SiteInfo>
      expect(body.data!.name).toBe("journal")
      expect(body.data!.url).toBe("https://journal.example.com")

      // Old container removed before the dirs moved, new one started after
      expect(runtime.callsOf("remove")[0]!.args[0]).toBe("blog")
      const runCall = runtime.callsOf("run")[0]!
      expect((runCall.args[0] as { name: string }).name).toBe("journal")

      // Old name gone, new name resolvable
      const old = await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "GET", headers: { "X-API-Key": "test-key" } }))
      expect(old.status).toBe(404)
      const dl = await server.handleRequestForTest(
        new Request("http://x/sites/journal/download", { method: "GET", headers: { "X-API-Key": "test-key" } })
      )
      expect(dl.status).toBe(200)
    })

    test("rename to an existing site name is rejected", async () => {
      await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() }))
      await server.handleRequestForTest(new Request("http://x/sites/shop", { method: "POST", headers: H, body: zip() }))
      const res = await server.handleRequestForTest(
        new Request("http://x/sites/blog/rename", {
          method: "PATCH",
          headers: { "X-API-Key": "test-key", "Content-Type": "application/json" },
          body: JSON.stringify({ newSubdomain: "shop" }),
        })
      )
      expect(res.status).toBe(400)
    })

    test("rename to a reserved name is rejected", async () => {
      await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() }))
      const res = await server.handleRequestForTest(
        new Request("http://x/sites/blog/rename", {
          method: "PATCH",
          headers: { "X-API-Key": "test-key", "Content-Type": "application/json" },
          body: JSON.stringify({ newSubdomain: "api" }),
        })
      )
      expect(res.status).toBe(400)
    })
  })

  describe("PocketBase upgrade", () => {
    const K = { "X-API-Key": "test-key" }
    const OLD = "0.1.0"
    const dataFile = () => join(dataDir, "pocket-data", "blog", "data.db")
    type UpgradeBody = ApiResponse<{ from: string; to: string; upgraded: boolean; backup?: string; site: SiteInfo }>

    // A deployed site still on an older PocketBase, with some pb_data.
    beforeEach(async () => {
      await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() }))
      const metaPath = join(dataDir, "pockets", "blog.json")
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"))
      writeFileSync(metaPath, JSON.stringify({ ...meta, pocketbaseVersion: OLD }))
      writeFileSync(dataFile(), "old-format")
      runtime.calls = []
    })
    const upgrade = () => server.handleRequestForTest(new Request("http://x/sites/blog/upgrade", { method: "POST", headers: K }))
    const siteMeta = () => JSON.parse(readFileSync(join(dataDir, "pockets", "blog.json"), "utf-8"))

    test("snapshots pb_data with the container stopped, then starts the new image", async () => {
      runtime.logsReturn = "Server started at http://0.0.0.0:8090"
      const res = await upgrade()
      expect(res.status).toBe(200)
      const body = (await res.json()) as UpgradeBody
      expect(body.data).toMatchObject({ from: OLD, to: POCKETBASE_VERSION, upgraded: true })
      expect(body.data!.site.pocketbaseVersion).toBe(POCKETBASE_VERSION)
      expect(readFileSync(join(body.data!.backup!, "data.db"), "utf-8")).toBe("old-format")

      const order = runtime.calls.map((c) => c.method).filter((m) => ["pull", "remove", "run"].includes(m))
      expect(order.slice(0, 3)).toEqual(["pull", "remove", "run"])
      expect(runtime.callsOf("pull")[0]!.args[0]).toBe(pocketbaseImage(POCKETBASE_VERSION))
      expect((runtime.callsOf("run")[0]!.args[0] as { image: string }).image).toBe(pocketbaseImage(POCKETBASE_VERSION))
    })

    test("a site already on the agent's version is a no-op: no container churn, no snapshot", async () => {
      writeFileSync(join(dataDir, "pockets", "blog.json"), JSON.stringify({ ...siteMeta(), pocketbaseVersion: POCKETBASE_VERSION }))
      const res = await upgrade()
      const body = (await res.json()) as UpgradeBody
      expect(body.data!.upgraded).toBe(false)
      expect(runtime.calls.filter((c) => ["pull", "remove", "run"].includes(c.method))).toEqual([])
      expect(existsSync(join(dataDir, "pocket-data-backups", "blog"))).toBe(false)
    })

    test("if the new PocketBase exits during startup, pb_data and the old version are restored", async () => {
      runtime.logsReturn = "panic: migration failed"
      runtime.isRunningReturn = false
      // Simulate the new version rewriting pb_data before it crashed.
      const realRun = runtime.run.bind(runtime)
      runtime.run = async (config) => {
        if (config.image === pocketbaseImage(POCKETBASE_VERSION)) writeFileSync(dataFile(), "half-migrated")
        return realRun(config)
      }
      const res = await upgrade()
      expect(res.status).toBe(500)
      const body = (await res.json()) as ApiResponse<unknown>
      expect(body.error).toContain(`restored to ${OLD}`)
      expect(body.error).toContain("panic: migration failed")
      expect(readFileSync(dataFile(), "utf-8")).toBe("old-format")
      expect(siteMeta().pocketbaseVersion).toBe(OLD)
      const images = runtime.callsOf("run").map((c) => (c.args[0] as { image: string }).image)
      expect(images).toEqual([pocketbaseImage(POCKETBASE_VERSION), pocketbaseImage(OLD)])
    })

    test("if the new PocketBase never reports started, it times out and restores", async () => {
      runtime.logsReturn = ""
      server.siteStartTimeoutMs = 0
      const res = await upgrade()
      expect(res.status).toBe(500)
      expect(siteMeta().pocketbaseVersion).toBe(OLD)
      expect(readFileSync(dataFile(), "utf-8")).toBe("old-format")
    })

    test("a failed image pull leaves the site completely untouched", async () => {
      runtime.pull = async () => { throw new Error("manifest unknown") }
      const res = await upgrade()
      expect(res.status).toBe(500)
      expect(((await res.json()) as ApiResponse<unknown>).error).toContain("manifest unknown")
      expect(runtime.calls.filter((c) => ["remove", "run"].includes(c.method))).toEqual([])
      expect(existsSync(join(dataDir, "pocket-data-backups", "blog"))).toBe(false)
      expect(siteMeta().pocketbaseVersion).toBe(OLD)
    })

    test("if even the restore fails, the site is marked failed and the error names the snapshot", async () => {
      runtime.logsReturn = ""
      runtime.isRunningReturn = false
      let runs = 0
      runtime.run = async () => { if (++runs === 2) throw new Error("docker daemon gone"); return "id" }
      const res = await upgrade()
      expect(res.status).toBe(500)
      const error = ((await res.json()) as ApiResponse<unknown>).error!
      expect(error).toContain("docker daemon gone")
      expect(error).toContain(join(dataDir, "pocket-data-backups", "blog"))
      expect(siteMeta().status).toBe("failed")
    })

    test("upgrading a missing site is a 404", async () => {
      const res = await server.handleRequestForTest(new Request("http://x/sites/nope/upgrade", { method: "POST", headers: K }))
      expect(res.status).toBe(404)
    })

    test("requires auth", async () => {
      const res = await server.handleRequestForTest(new Request("http://x/sites/blog/upgrade", { method: "POST" }))
      expect(res.status).toBe(401)
      expect(siteMeta().pocketbaseVersion).toBe(OLD)
    })
  })

  test("deprecated /pockets/* alias routes to the same handlers", async () => {
    await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() }))
    const viaAlias = await server.handleRequestForTest(new Request("http://x/pockets", { method: "GET", headers: { "X-API-Key": "test-key" } }))
    const aliasBody = (await viaAlias.json()) as ApiResponse<SiteInfo[]>
    expect(aliasBody.data).toHaveLength(1)
    const viaAliasGet = await server.handleRequestForTest(new Request("http://x/pockets/blog", { method: "GET", headers: { "X-API-Key": "test-key" } }))
    expect(viaAliasGet.status).toBe(200)
  })

  test("legacy flat static zip deploys with files wrapped under public/", async () => {
    const flat = zipSync({ "index.html": new TextEncoder().encode("<h1>legacy</h1>") })
    const res = await server.handleRequestForTest(
      new Request("http://x/sites/old", { method: "POST", headers: H, body: flat })
    )
    expect(res.status).toBe(200)
    const dl = await server.handleRequestForTest(
      new Request("http://x/sites/old/download", { method: "GET", headers: { "X-API-Key": "test-key" } })
    )
    const { unzipSync } = await import("fflate")
    const files = unzipSync(new Uint8Array(await dl.arrayBuffer()))
    expect(new TextDecoder().decode(files["public/index.html"]!)).toBe("<h1>legacy</h1>")
  })

  test("GET /health carries the agent version for CLI skew detection", async () => {
    const res = await server.handleRequestForTest(new Request("http://x/health", { method: "GET" }))
    const body = (await res.json()) as ApiResponse<{ status: string; version?: string }>
    expect(body.data!.status).toBe("ok")
    expect(body.data!.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  test("DELETE /sites/:name removes it", async () => {
    await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() }))
    const del = await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "DELETE", headers: { "X-API-Key": "test-key" } }))
    expect(del.status).toBe(200)
    const list = await server.handleRequestForTest(new Request("http://x/sites", { method: "GET", headers: { "X-API-Key": "test-key" } }))
    const body = (await list.json()) as ApiResponse<SiteInfo[]>
    expect(body.data).toHaveLength(0)
  })

  // Thumbnails are disabled in test mode (skipTraefik), so the manager is off;
  // these lock the route wiring and the hasThumbnail contract the UI reads.
  test("GET /sites/:name/thumbnail is 404 when no preview exists", async () => {
    await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() }))
    const res = await server.handleRequestForTest(
      new Request("http://x/sites/blog/thumbnail", { method: "GET", headers: { "X-API-Key": "test-key" } })
    )
    expect(res.status).toBe(404)
  })

  test("GET /sites/:name/thumbnail requires auth", async () => {
    const res = await server.handleRequestForTest(new Request("http://x/sites/blog/thumbnail", { method: "GET" }))
    expect(res.status).toBe(401)
  })

  test("GET /sites exposes hasThumbnail so the UI knows when to fetch a preview", async () => {
    await server.handleRequestForTest(new Request("http://x/sites/blog", { method: "POST", headers: H, body: zip() }))
    const res = await server.handleRequestForTest(new Request("http://x/sites", { method: "GET", headers: { "X-API-Key": "test-key" } }))
    const body = (await res.json()) as ApiResponse<SiteInfo[]>
    expect(body.data?.[0]?.hasThumbnail).toBe(false)
  })
})
