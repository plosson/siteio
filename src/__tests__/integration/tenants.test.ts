import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { AgentServer } from "../../lib/agent/server.ts"
import { mkdirSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { zipSync } from "fflate"
import type { ApiResponse, SiteInfo, Tenant } from "../../types.ts"

// Traefik serves its self-signed default certificate locally.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"

// Container pulls and starts are slow.
setDefaultTimeout(90000)

/**
 * Tenant integration tests: REAL Docker containers and Traefik routing.
 *
 * The operator (test.local) and a tenant (friend.local) both deploy a site
 * called `blog`. Each hostname must reach its own container, and the tenant's
 * API host must reach the agent through Traefik. Skipped without Docker.
 *
 * Prerequisites:
 * - Docker daemon running
 * - Ports 20080, 20443, 15099 available (distinct from docker.test.ts and git-deploy.test.ts)
 */

const DATA_DIR = join(import.meta.dir, ".test-data-tenants-integration")
const PRIMARY = "test.local"
const GOD_KEY = "tenants-integration-god-key"
const TENANT: Tenant = {
  domain: "friend.local",
  apiKey: "tenants-integration-friend-key",
  createdAt: "2026-10-08T00:00:00.000Z",
}
const HTTP_PORT = 20080
const HTTPS_PORT = 20443
const API_PORT = 15099
// Only the containers this file creates — never other siteio containers.
const CONTAINERS = ["siteio-blog", "siteio-blog--friend-local"]

function isDockerAvailable(): boolean {
  return Bun.spawnSync({ cmd: ["docker", "info"], stdout: "pipe", stderr: "pipe" }).exitCode === 0
}

function removeContainers(): void {
  for (const name of CONTAINERS) {
    Bun.spawnSync({ cmd: ["docker", "rm", "-f", name], stdout: "pipe", stderr: "pipe" })
  }
}

const zip = (html: string) => zipSync({ "public/index.html": new TextEncoder().encode(html) })

// A request through Traefik, addressed by Host header like a real browser/CLI.
function viaTraefik(host: string, path = "/", init: RequestInit = {}): Promise<Response> {
  return fetch(`https://localhost:${HTTPS_PORT}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), Host: host },
    signal: AbortSignal.timeout(5000),
  })
}

// Poll until `check` accepts a response (Traefik picks up docker labels async).
async function waitFor(
  host: string,
  check: (res: Response, body: string) => boolean,
  timeoutMs = 30000,
  path = "/"
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await viaTraefik(host, path)
      if (check(res, await res.text())) return true
    } catch {
      // Traefik or the container is not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

describe("Integration: tenants", () => {
  let server: AgentServer
  let dockerAvailable = false
  const api = `http://localhost:${API_PORT}`

  beforeAll(async () => {
    dockerAvailable = isDockerAvailable()
    if (!dockerAvailable) {
      console.log("⚠️  Docker not available - skipping tenant integration tests")
      return
    }
    removeContainers()
    if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true })
    mkdirSync(DATA_DIR, { recursive: true })

    server = new AgentServer({
      domain: PRIMARY,
      apiKey: GOD_KEY,
      dataDir: DATA_DIR,
      maxUploadSize: 10 * 1024 * 1024,
      port: API_PORT,
      httpPort: HTTP_PORT,
      httpsPort: HTTPS_PORT,
      tenants: [TENANT],
    })
    await server.start()

    // Traefik is up once it answers (404 for an unknown host is fine).
    const ready = await waitFor("unknown.invalid", (res) => res.status === 404 || res.ok)
    if (!ready) throw new Error("Traefik failed to start within timeout")
  })

  afterAll(() => {
    if (!dockerAvailable) return
    server?.stop() // also stops Traefik
    removeContainers()
    if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true })
  })

  it("routes the tenant's api host to the agent through Traefik", async () => {
    if (!dockerAvailable) return
    expect(await waitFor(`api.${TENANT.domain}`, (res) => res.ok, 30000, "/health")).toBe(true)
  })

  it("serves the operator's and the tenant's `blog` from separate containers", async () => {
    if (!dockerAvailable) return

    const god = await fetch(`${api}/sites/blog`, {
      method: "POST",
      headers: { "X-API-Key": GOD_KEY, "Content-Type": "application/zip" },
      body: zip("<h1>Operator blog</h1>"),
    })
    expect(god.ok).toBe(true)

    // The tenant deploys through Traefik, on its own api host.
    const tenant = await viaTraefik(`api.${TENANT.domain}`, "/sites/blog", {
      method: "POST",
      headers: { "X-API-Key": TENANT.apiKey, "Content-Type": "application/zip" },
      body: zip("<h1>Friend blog</h1>"),
    })
    expect(tenant.ok).toBe(true)
    const info = ((await tenant.json()) as ApiResponse<SiteInfo>).data!
    expect(info.name).toBe("blog")
    expect(info.url).toBe(`https://blog.${TENANT.domain}`)

    expect(await waitFor(`blog.${PRIMARY}`, (res, body) => res.ok && body.includes("Operator blog"))).toBe(true)
    expect(await waitFor(`blog.${TENANT.domain}`, (res, body) => res.ok && body.includes("Friend blog"))).toBe(true)
  })

  it("refuses the tenant key on the operator's api host", async () => {
    if (!dockerAvailable) return
    const res = await viaTraefik(`api.${PRIMARY}`, "/sites", { headers: { "X-API-Key": TENANT.apiKey } })
    expect(res.status).toBe(401)
  })

  it("shows the tenant only its own site", async () => {
    if (!dockerAvailable) return
    const res = await viaTraefik(`api.${TENANT.domain}`, "/sites", { headers: { "X-API-Key": TENANT.apiKey } })
    const sites = ((await res.json()) as ApiResponse<SiteInfo[]>).data!
    expect(sites.map((s) => [s.name, s.url])).toEqual([["blog", `https://blog.${TENANT.domain}`]])
  })

  it("deleting the tenant's blog leaves the operator's blog serving", async () => {
    if (!dockerAvailable) return
    const res = await viaTraefik(`api.${TENANT.domain}`, "/sites/blog", {
      method: "DELETE",
      headers: { "X-API-Key": TENANT.apiKey },
    })
    expect(res.ok).toBe(true)
    expect(await waitFor(`blog.${TENANT.domain}`, (r) => r.status === 404)).toBe(true)
    expect(await waitFor(`blog.${PRIMARY}`, (r, body) => r.ok && body.includes("Operator blog"))).toBe(true)
  })
})
