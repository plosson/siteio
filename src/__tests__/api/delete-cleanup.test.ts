// src/__tests__/api/delete-cleanup.test.ts
// What DELETE /apps/:name and DELETE /sites/:name remove, keep and report.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import { pocketbaseImage } from "../../lib/pocketbase-version.ts"
import type { AgentConfig, ApiResponse, DeleteResult } from "../../types.ts"

const inlineCompose = `services:
  web:
    image: nginx
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
`

describe("API: delete cleanup", () => {
  let dataDir: string
  let runtime: FakeRuntime
  let server: AgentServer

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-delete-"))
    runtime = new FakeRuntime()
    const config: AgentConfig = {
      apiKey: "test-key", dataDir, domain: "example.com",
      maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
    }
    server = new AgentServer(config, runtime)
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  const req = (method: string, path: string, body?: object) =>
    server.handleRequestForTest(
      new Request(`http://x${path}`, {
        method,
        headers: { "X-API-Key": "test-key", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      })
    )

  const parse = async <T>(r: Response) => (await r.json()) as ApiResponse<T>

  const composeApp = async (name: string) => {
    const created = await req("POST", "/apps", { name, composeContent: inlineCompose, primaryService: "web", internalPort: 80 })
    expect(created.status).toBeLessThan(300)
    runtime.composeConfigReturn = { services: { web: {}, db: {} } }
    expect((await req("POST", `/apps/${name}/deploy`)).status).toBeLessThan(300)
    runtime.calls = []
  }

  const imageApp = async (name: string, image = "nginx:alpine") => {
    const created = await req("POST", "/apps", { name, image, internalPort: 80 })
    expect(created.status).toBeLessThan(300)
    runtime.calls = []
  }

  // A siteio-managed volume folder, as `apps set -v data:/data` would create
  const managedVolume = (name: string) => {
    const dir = join(dataDir, "volumes", name, "data")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "db.sqlite"), "x")
    return join(dataDir, "volumes", name)
  }

  describe("compose apps", () => {
    test("default: down -v, no --rmi, leftovers checked, files and volumes folder removed", async () => {
      await composeApp("stack")
      const volumes = managedVolume("stack")
      const r = await req("DELETE", "/apps/stack")
      expect(r.status).toBe(200)
      const body = await parse<DeleteResult>(r)
      expect(body.data).toEqual({ deleted: true, warnings: [] })

      const down = runtime.callsOf("composeDown")
      expect(down).toHaveLength(1)
      expect(down[0]!.args[0]).toBe("siteio-stack")
      expect(down[0]!.args[3]).toEqual({ keepVolumes: false, removeImages: false })
      expect(runtime.callsOf("projectLeftovers")[0]!.args[0]).toBe("siteio-stack")
      expect(existsSync(join(dataDir, "compose", "stack"))).toBe(false)
      expect(existsSync(volumes)).toBe(false)
      expect((await req("GET", "/apps/stack")).status).toBe(404)
    })

    test("keepData skips -v and keeps the volumes folder; kept volumes are reported", async () => {
      await composeApp("keep")
      const volumes = managedVolume("keep")
      runtime.projectLeftoversReturn = { containers: [], networks: [], volumes: ["siteio-keep_pgdata"] }
      const r = await req("DELETE", "/apps/keep?keepData=true")
      const body = await parse<DeleteResult>(r)
      expect(r.status).toBe(200)
      expect(runtime.callsOf("composeDown")[0]!.args[3]).toEqual({ keepVolumes: true, removeImages: false })
      expect(existsSync(volumes)).toBe(true)
      expect(body.data!.warnings).toEqual(["Kept volumes: siteio-keep_pgdata"])
    })

    test("images passes removeImages to down", async () => {
      await composeApp("imgs")
      const r = await req("DELETE", "/apps/imgs?images=1")
      expect(r.status).toBe(200)
      expect(runtime.callsOf("composeDown")[0]!.args[3]).toEqual({ keepVolumes: false, removeImages: true })
    })

    test("a failing --rmi all is retried without it and reported", async () => {
      await composeApp("rmifail")
      runtime.composeDownError = (opts) => (opts.removeImages ? new Error("image is in use") : null)
      const r = await req("DELETE", "/apps/rmifail?images=true")
      const body = await parse<DeleteResult>(r)
      expect(r.status).toBe(200)
      expect(runtime.callsOf("composeDown")).toHaveLength(2)
      expect(runtime.callsOf("composeDown")[1]!.args[3]).toEqual({ keepVolumes: false, removeImages: false })
      expect(body.data!.warnings).toEqual(["Could not remove the stack's images: image is in use"])
    })

    test("a failing down keeps the app and its files, and a retry finishes the job", async () => {
      await composeApp("stuck")
      const volumes = managedVolume("stuck")
      runtime.composeDownError = new Error("docker compose down failed: volume is in use")
      const r = await req("DELETE", "/apps/stuck")
      const body = await parse<null>(r)
      expect(r.status).toBe(500)
      expect(body.success).toBe(false)
      expect(body.reason).toBe("cleanup_failed")
      expect(body.error).toContain("volume is in use")
      expect((await req("GET", "/apps/stuck")).status).toBe(200)
      expect(existsSync(join(dataDir, "compose", "stuck", "docker-compose.yml"))).toBe(true)
      expect(existsSync(volumes)).toBe(true)

      runtime.composeDownError = null
      const retry = await req("DELETE", "/apps/stuck")
      expect(retry.status).toBe(200)
      expect((await req("GET", "/apps/stuck")).status).toBe(404)
      expect(existsSync(volumes)).toBe(false)
    })

    test("ignoreErrors removes the app anyway and reports the failure", async () => {
      await composeApp("forced")
      runtime.composeDownError = new Error("Cannot connect to the Docker daemon")
      const r = await req("DELETE", "/apps/forced?ignoreErrors=true")
      const body = await parse<DeleteResult>(r)
      expect(r.status).toBe(200)
      expect(body.data!.warnings[0]).toContain("Cannot connect to the Docker daemon")
      expect((await req("GET", "/apps/forced")).status).toBe(404)
    })

    test("leftover networks and volumes are warnings; leftover containers keep the app", async () => {
      await composeApp("left")
      runtime.projectLeftoversReturn = { containers: [], networks: ["siteio-left_data"], volumes: ["siteio-left_pgdata"] }
      const warned = await req("DELETE", "/apps/left")
      expect(warned.status).toBe(200)
      expect((await parse<DeleteResult>(warned)).data!.warnings).toEqual([
        "Docker resources still tied to siteio-left: networks siteio-left_data; volumes siteio-left_pgdata",
      ])

      await composeApp("busy")
      runtime.projectLeftoversReturn = { containers: ["siteio-busy-db-1"], networks: [], volumes: [] }
      const kept = await req("DELETE", "/apps/busy")
      expect(kept.status).toBe(500)
      expect((await parse<null>(kept)).error).toContain("containers siteio-busy-db-1")
      expect((await req("GET", "/apps/busy")).status).toBe(200)
    })

    test("names the containers still mounting a leftover volume", async () => {
      await composeApp("mounted")
      runtime.projectLeftoversReturn = {
        containers: [],
        networks: [],
        volumes: ["siteio-mounted_appdata"],
        volumeUsers: { "siteio-mounted_appdata": ["rakazo-computer-bot-1"] },
      }
      const r = await req("DELETE", "/apps/mounted")
      expect(r.status).toBe(200)
      expect((await parse<DeleteResult>(r)).data!.warnings).toEqual([
        "Docker resources still tied to siteio-mounted: volumes siteio-mounted_appdata (volume siteio-mounted_appdata is still mounted by rakazo-computer-bot-1)",
      ])
    })

    test("a failed leftover check is a warning, not a failure", async () => {
      await composeApp("nocheck")
      runtime.projectLeftoversError = new Error("docker ps failed")
      const r = await req("DELETE", "/apps/nocheck")
      expect(r.status).toBe(200)
      expect((await parse<DeleteResult>(r)).data!.warnings).toEqual([
        "Could not check for leftover Docker resources: docker ps failed",
      ])
    })
  })

  describe("image apps", () => {
    test("a failing container removal keeps the app", async () => {
      await imageApp("web")
      runtime.containerExistsReturn = true
      runtime.removeError = new Error("device or resource busy")
      const r = await req("DELETE", "/apps/web")
      expect(r.status).toBe(500)
      expect((await parse<null>(r)).error).toContain("Failed to remove container siteio-web: device or resource busy")
      expect((await req("GET", "/apps/web")).status).toBe(200)
    })

    test("the pulled image stays by default", async () => {
      await imageApp("web")
      const volumes = managedVolume("web")
      expect((await req("DELETE", "/apps/web")).status).toBe(200)
      expect(runtime.callsOf("removeImage")).toHaveLength(0)
      expect(existsSync(volumes)).toBe(false)
    })

    test("images removes the pulled image, not forced, when nothing else uses it", async () => {
      await imageApp("web", "ghcr.io/acme/web:1")
      expect((await req("DELETE", "/apps/web?images=true")).status).toBe(200)
      expect(runtime.callsOf("removeImage").map((c) => c.args)).toEqual([["ghcr.io/acme/web:1", { force: false }]])
    })

    test("images keeps an image another app uses", async () => {
      await imageApp("one", "redis:7")
      await imageApp("two", "redis:7")
      const r = await req("DELETE", "/apps/one?images=true")
      expect(r.status).toBe(200)
      expect(runtime.callsOf("removeImage")).toHaveLength(0)
      expect((await parse<DeleteResult>(r)).data!.warnings).toEqual(["Kept image redis:7: also used by app two"])
    })

    test("a failing image removal is a warning", async () => {
      await imageApp("web", "ghcr.io/acme/web:2")
      runtime.removeImageError = new Error("conflict: image is being used")
      const r = await req("DELETE", "/apps/web?images=true")
      expect(r.status).toBe(200)
      expect((await parse<DeleteResult>(r)).data!.warnings).toEqual([
        "Failed to remove image ghcr.io/acme/web:2: conflict: image is being used",
      ])
      expect((await req("GET", "/apps/web")).status).toBe(404)
    })

    test("keepData keeps the volumes folder", async () => {
      await imageApp("web")
      const volumes = managedVolume("web")
      expect((await req("DELETE", "/apps/web?keepData=true")).status).toBe(200)
      expect(existsSync(volumes)).toBe(true)
    })
  })

  describe("sites", () => {
    const deploySite = async (name: string) => {
      const res = await server.handleRequestForTest(
        new Request(`http://x/sites/${name}`, {
          method: "POST",
          headers: { "X-API-Key": "test-key", "Content-Type": "application/zip" },
          body: zipSync({ "public/index.html": new TextEncoder().encode("<h1>hi</h1>") }),
        })
      )
      expect(res.status).toBe(200)
      runtime.calls = []
    }

    test("a failing container removal keeps the site and its data", async () => {
      await deploySite("blog")
      runtime.containerExistsReturn = true
      runtime.removeError = new Error("device or resource busy")
      const r = await req("DELETE", "/sites/blog")
      expect(r.status).toBe(500)
      expect((await parse<null>(r)).reason).toBe("cleanup_failed")
      expect((await req("GET", "/sites/blog")).status).toBe(200)
      expect(existsSync(join(dataDir, "pocket-code", "blog"))).toBe(true)
    })

    test("ignoreErrors removes the site anyway", async () => {
      await deploySite("blog")
      runtime.containerExistsReturn = true
      runtime.removeError = new Error("device or resource busy")
      const r = await req("DELETE", "/sites/blog?ignoreErrors=true")
      expect(r.status).toBe(200)
      expect((await parse<DeleteResult>(r)).data!.warnings[0]).toContain("device or resource busy")
      expect((await req("GET", "/sites/blog")).status).toBe(404)
    })

    test("images keeps an app image that a site's PocketBase uses", async () => {
      await deploySite("blog")
      await imageApp("pb", pocketbaseImage())
      const r = await req("DELETE", "/apps/pb?images=true")
      expect((await parse<DeleteResult>(r)).data!.warnings).toEqual([`Kept image ${pocketbaseImage()}: also used by site blog`])
    })
  })
})
