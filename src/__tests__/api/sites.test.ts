// src/__tests__/api/pockets.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import { POCKETBASE_IMAGE, POCKETBASE_VERSION } from "../../lib/pocketbase-version.ts"
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
    expect(pullCall!.args[0]).toBe(POCKETBASE_IMAGE)
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

      const labelCall = runtime.callsOf("buildTraefikLabels")[0]!
      expect(labelCall.args[1]).toEqual(["blog.example.com", "www.custom.org", "custom.org"])
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
})
