# PocketBase Per-Site Storage — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the custom localStorage shim + proxy approach with one PocketBase instance per site, giving static sites a full backend (DB, auth, admin UI, realtime) with zero custom server-side code.

**Architecture:** When a site enables PocketBase, siteio starts a dedicated PocketBase Docker container (`siteio-pb-{subdomain}`) on the `siteio-network`. Traefik routes `/api/` and `/_/` paths to the PocketBase container via the dynamic YAML config (path-prefix routers with higher priority than the site's catch-all router). Everything else continues to be served by nginx as static files. Data is stored at `{dataDir}/pocketbase/{subdomain}/`.

**Tech Stack:** Bun, TypeScript, PocketBase (Docker), Traefik (dynamic YAML config), Commander.js

---

## Context

The existing branch (`feat/persistent-storage`) has a working localStorage shim approach. This plan replaces it entirely with PocketBase. The shim code will be removed and replaced with PocketBase container management.

### What changes

| Component | Remove | Add |
|---|---|---|
| `src/lib/agent/persistent-storage.ts` | Entire file | — |
| `src/lib/agent/storage-shim.ts` | Entire file | — |
| `src/lib/agent/pocketbase.ts` | — | New: PocketBaseManager |
| `src/lib/agent/server.ts` | `/__storage/` routes, shim import | PocketBase enable/disable in toggle handler |
| `src/lib/agent/traefik.ts` | `generateStorageExtra()`, nginx sub_filter | PocketBase Traefik routers in dynamic config |
| `src/lib/agent/storage.ts` | — | Rename field: `persistentStorage` → `pocketbase` |
| `src/types.ts` | `persistentStorage` field | `pocketbase` field |
| `src/lib/client.ts` | `updateSitePersistentStorage` | `updateSitePocketBase` |
| CLI commands | `--persistent-storage` flags | `--pocketbase` / `--no-pocketbase` flags |
| Tests | Shim/proxy tests | PocketBase integration tests |

### Docker image strategy

PocketBase doesn't publish an official Docker image. We build a minimal image locally:

```dockerfile
FROM alpine:3.21
ARG PB_VERSION=0.25.2
ADD https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_amd64.zip /tmp/pb.zip
RUN unzip /tmp/pb.zip -d /pb && rm /tmp/pb.zip && chmod +x /pb/pocketbase
EXPOSE 8090
CMD ["/pb/pocketbase", "serve", "--http=0.0.0.0:8090"]
```

The `PocketBaseManager` builds this image once (tagged `siteio-pocketbase:latest`) and reuses it for all sites.

### Routing

For a site `mysite.example.com` with PocketBase enabled, the Traefik dynamic config gets two additional routers:

```yaml
http:
  routers:
    site-mysite-pb:
      rule: "Host(`mysite.example.com`) && (PathPrefix(`/api/`) || PathPrefix(`/_/`))"
      entryPoints: ["websecure"]
      service: site-mysite-pb
      tls:
        certResolver: letsencrypt
      priority: 100
  services:
    site-mysite-pb:
      loadBalancer:
        servers:
          - url: "http://siteio-pb-mysite:8090"
```

The priority of 100 ensures the path-prefix router takes precedence over the host-only router that sends traffic to nginx.

---

## Task 1: Remove existing shim-based persistent storage

**Files:**
- Delete: `src/lib/agent/persistent-storage.ts`
- Delete: `src/lib/agent/storage-shim.ts`
- Delete: `src/__tests__/unit/persistent-storage.test.ts`
- Delete: `src/__tests__/api/persistent-storage.test.ts`
- Modify: `src/lib/agent/server.ts`
- Modify: `src/lib/agent/traefik.ts`

**Step 1: Delete the shim and persistent-storage files**

```bash
rm src/lib/agent/persistent-storage.ts
rm src/lib/agent/storage-shim.ts
rm src/__tests__/unit/persistent-storage.test.ts
rm src/__tests__/api/persistent-storage.test.ts
```

**Step 2: Remove shim references from server.ts**

In `src/lib/agent/server.ts`:
- Remove imports: `PersistentStorageManager` and `STORAGE_SHIM_JS`
- Remove the `persistentStorage` field from the class
- Remove `this.persistentStorage = new PersistentStorageManager(config.dataDir)` from constructor
- Remove the `/__storage/shim.js` route handler
- Remove the `/__storage/` GET and PUT route handlers
- Remove `handleStorageShim()`, `handleStorageGet()`, `handleStoragePut()` methods
- Remove `this.persistentStorage.deleteSite(subdomain)` from `handleUndeploy`

**Step 3: Remove nginx sub_filter from traefik.ts**

In `src/lib/agent/traefik.ts`:
- Remove the `generateStorageExtra()` method entirely
- In `generateNginxConfig()`, remove the `if (site.persistentStorage)` block that creates per-site server blocks with storage extra
- In the custom domains loop, remove the `site.persistentStorage ? this.generateStorageExtra() : ""` conditional — custom domain blocks should only be generated when `site.domains` exists

**Step 4: Run typecheck to verify clean removal**

Run: `bun run typecheck`
Expected: Errors about `persistentStorage` references in types/storage/client/CLI (those will be fixed in later tasks)

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove shim-based persistent storage implementation"
```

---

## Task 2: Rename `persistentStorage` to `pocketbase` across types

**Files:**
- Modify: `src/types.ts`
- Modify: `src/lib/agent/storage.ts`
- Modify: `src/lib/agent/server.ts`
- Modify: `src/lib/client.ts`
- Modify: `src/commands/sites/set.ts`
- Modify: `src/commands/sites/info.ts`
- Modify: `src/commands/sites/deploy.ts`
- Modify: `src/cli.ts`

**Step 1: Update types**

In `src/types.ts`, rename the field in both interfaces:
- `SiteMetadata`: `persistentStorage?: boolean` → `pocketbase?: boolean`
- `SiteInfo`: `persistentStorage?: boolean` → `pocketbase?: boolean`

**Step 2: Update SiteStorage**

In `src/lib/agent/storage.ts`:
- Rename `updatePersistentStorage` → `updatePocketBase`
- Update all references to `persistentStorage` → `pocketbase` in `extractAndStore()` and `rollback()`

**Step 3: Update server.ts**

In `src/lib/agent/server.ts`:
- In `handleListSites`: `persistentStorage: site.persistentStorage` → `pocketbase: site.pocketbase`
- In `handleDeploy`: rename header check from `X-Site-Persistent-Storage` → `X-Site-PocketBase`, and update field references
- In all `SiteInfo` response mappings: `persistentStorage` → `pocketbase`
- In `handleToggleStorage`: `updatePersistentStorage` → `updatePocketBase`, response field → `pocketbase`

**Step 4: Update client.ts**

In `src/lib/client.ts`:
- Rename `updateSitePersistentStorage` → `updateSitePocketBase`
- In `deploySite()`: rename `persistentStorage` option and header to `pocketbase` / `X-Site-PocketBase`

**Step 5: Update CLI commands**

In `src/cli.ts`:
- `sites deploy`: `--persistent-storage` → `--pocketbase`
- `sites set`: `--persistent-storage` / `--no-persistent-storage` → `--pocketbase` / `--no-pocketbase`

In `src/commands/sites/set.ts`:
- `SetSiteOptions`: `persistentStorage` → `pocketbase`
- Update all references

In `src/commands/sites/deploy.ts`:
- Update option name references

In `src/commands/sites/info.ts`:
- `site.persistentStorage` → `site.pocketbase`
- Display label: "Persistent Storage" → "PocketBase"

**Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (no type errors)

**Step 7: Run existing tests**

Run: `bun test`
Expected: All non-deleted tests pass

**Step 8: Commit**

```bash
git add -A
git commit -m "refactor: rename persistentStorage to pocketbase across codebase"
```

---

## Task 3: Create PocketBaseManager

**Files:**
- Create: `src/lib/agent/pocketbase.ts`
- Test: `src/__tests__/unit/pocketbase.test.ts`

**Step 1: Write the unit test**

```typescript
// src/__tests__/unit/pocketbase.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { PocketBaseManager } from "../../lib/agent/pocketbase.ts"

describe("PocketBaseManager", () => {
  let dataDir: string
  let manager: PocketBaseManager

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-pb-test-"))
    manager = new PocketBaseManager(dataDir)
  })

  afterEach(() => {
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true })
    }
  })

  test("containerName returns correct name", () => {
    expect(manager.containerName("mysite")).toBe("siteio-pb-mysite")
  })

  test("dataPath returns correct path", () => {
    expect(manager.dataPath("mysite")).toBe(join(dataDir, "pocketbase", "mysite"))
  })

  test("dataPath creates directory if needed", () => {
    const path = manager.dataPath("newsite")
    expect(existsSync(path)).toBe(true)
  })

  test("generateDockerfile returns valid Dockerfile", () => {
    const df = manager.generateDockerfile()
    expect(df).toContain("FROM alpine")
    expect(df).toContain("pocketbase")
    expect(df).toContain("EXPOSE 8090")
  })

  test("cleanup removes data directory", () => {
    // Create the data dir first
    manager.dataPath("cleanup-test")
    expect(existsSync(join(dataDir, "pocketbase", "cleanup-test"))).toBe(true)

    manager.cleanup("cleanup-test")
    expect(existsSync(join(dataDir, "pocketbase", "cleanup-test"))).toBe(false)
  })

  test("cleanup is safe for non-existent site", () => {
    expect(() => manager.cleanup("nonexistent")).not.toThrow()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/pocketbase.test.ts`
Expected: FAIL — module not found

**Step 3: Implement PocketBaseManager**

```typescript
// src/lib/agent/pocketbase.ts
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { spawnSync } from "bun"
import { SiteioError } from "../../utils/errors"

const PB_IMAGE_TAG = "siteio-pocketbase:latest"
const PB_VERSION = "0.25.2"
const PB_INTERNAL_PORT = 8090

export class PocketBaseManager {
  private dataDir: string
  private pbDir: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.pbDir = join(dataDir, "pocketbase")
    if (!existsSync(this.pbDir)) {
      mkdirSync(this.pbDir, { recursive: true })
    }
  }

  containerName(subdomain: string): string {
    return `siteio-pb-${subdomain}`
  }

  dataPath(subdomain: string): string {
    const path = join(this.pbDir, subdomain)
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true })
    }
    return path
  }

  generateDockerfile(): string {
    return `FROM alpine:3.21
ARG PB_VERSION=${PB_VERSION}
ADD https://github.com/pocketbase/pocketbase/releases/download/v\${PB_VERSION}/pocketbase_\${PB_VERSION}_linux_amd64.zip /tmp/pb.zip
RUN unzip /tmp/pb.zip -d /pb && rm /tmp/pb.zip && chmod +x /pb/pocketbase
EXPOSE ${PB_INTERNAL_PORT}
CMD ["/pb/pocketbase", "serve", "--http=0.0.0.0:${PB_INTERNAL_PORT}"]
`
  }

  /**
   * Build the PocketBase Docker image if it doesn't exist
   */
  ensureImage(): void {
    const result = spawnSync({
      cmd: ["docker", "image", "inspect", PB_IMAGE_TAG],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (result.exitCode === 0) return // Image exists

    // Write a temp Dockerfile and build
    const tmpDir = join(this.pbDir, ".build")
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true })
    }

    const dockerfilePath = join(tmpDir, "Dockerfile")
    writeFileSync(dockerfilePath, this.generateDockerfile())

    const buildResult = spawnSync({
      cmd: ["docker", "build", "-t", PB_IMAGE_TAG, "-f", dockerfilePath, tmpDir],
      stdout: "pipe",
      stderr: "pipe",
    })

    // Clean up build dir
    rmSync(tmpDir, { recursive: true })

    if (buildResult.exitCode !== 0) {
      throw new SiteioError(`Failed to build PocketBase image: ${buildResult.stderr.toString()}`)
    }
  }

  /**
   * Start a PocketBase container for a site
   */
  async start(subdomain: string): Promise<string> {
    const name = this.containerName(subdomain)
    const pbDataPath = this.dataPath(subdomain)

    // Remove existing container if present
    this.remove(subdomain)

    // Ensure image exists
    this.ensureImage()

    const result = spawnSync({
      cmd: [
        "docker", "run", "-d",
        "--name", name,
        "--network", "siteio-network",
        "--restart", "unless-stopped",
        "-v", `${pbDataPath}:/pb_data`,
        PB_IMAGE_TAG,
      ],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (result.exitCode !== 0) {
      throw new SiteioError(`Failed to start PocketBase container: ${result.stderr.toString()}`)
    }

    return result.stdout.toString().trim()
  }

  /**
   * Stop and remove a PocketBase container
   */
  remove(subdomain: string): void {
    const name = this.containerName(subdomain)
    spawnSync({
      cmd: ["docker", "rm", "-f", name],
      stdout: "pipe",
      stderr: "pipe",
    })
  }

  /**
   * Check if a PocketBase container is running
   */
  isRunning(subdomain: string): boolean {
    const name = this.containerName(subdomain)
    const result = spawnSync({
      cmd: ["docker", "inspect", "-f", "{{.State.Running}}", name],
      stdout: "pipe",
      stderr: "pipe",
    })
    return result.exitCode === 0 && result.stdout.toString().trim() === "true"
  }

  /**
   * Remove data directory for a site
   */
  cleanup(subdomain: string): void {
    const path = join(this.pbDir, subdomain)
    if (existsSync(path)) {
      rmSync(path, { recursive: true })
    }
  }

  /**
   * Get the internal URL for a site's PocketBase (used in Traefik config)
   */
  internalUrl(subdomain: string): string {
    return `http://${this.containerName(subdomain)}:${PB_INTERNAL_PORT}`
  }

  static get IMAGE_TAG(): string {
    return PB_IMAGE_TAG
  }

  static get INTERNAL_PORT(): number {
    return PB_INTERNAL_PORT
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/unit/pocketbase.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/pocketbase.ts src/__tests__/unit/pocketbase.test.ts
git commit -m "feat: add PocketBaseManager for per-site PocketBase containers"
```

---

## Task 4: Add PocketBase routing to Traefik dynamic config

**Files:**
- Modify: `src/lib/agent/traefik.ts`
- Modify: `src/__tests__/unit/traefik-manager.test.ts`

**Step 1: Write the failing tests**

Add these tests to `src/__tests__/unit/traefik-manager.test.ts`:

```typescript
describe("PocketBase routing", () => {
  test("should add PocketBase routers for sites with pocketbase enabled", () => {
    const config = manager.generateDynamicConfig([
      { subdomain: "mysite", size: 100, deployedAt: "2024-01-01", files: [], pocketbase: true },
    ])
    expect(config).toContain("site-mysite-pb")
    expect(config).toContain("PathPrefix(`/api/`)")
    expect(config).toContain("PathPrefix(`/_/`)")
    expect(config).toContain("siteio-pb-mysite:8090")
    expect(config).toContain("priority")
  })

  test("should not add PocketBase routers for sites without pocketbase", () => {
    const config = manager.generateDynamicConfig([
      { subdomain: "nosite", size: 100, deployedAt: "2024-01-01", files: [] },
    ])
    expect(config).not.toContain("site-nosite-pb")
    expect(config).not.toContain("siteio-pb-nosite")
  })

  test("should add PocketBase routers for custom domains too", () => {
    const config = manager.generateDynamicConfig([
      { subdomain: "mysite", size: 100, deployedAt: "2024-01-01", files: [], domains: ["custom.com"], pocketbase: true },
    ])
    expect(config).toContain("site-mysite-cd-0-pb")
    expect(config).toContain("Host(`custom.com`)")
    // Should appear twice: once for static, once for PB
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/unit/traefik-manager.test.ts`
Expected: FAIL

**Step 3: Update `generateDynamicConfig()` in traefik.ts**

In the `for (const site of sites)` loop, after the existing router code, add PocketBase routing:

```typescript
// Add PocketBase routers if enabled
if (site.pocketbase) {
  const pbServiceName = `site-${site.subdomain}-pb`
  const pbContainerName = `siteio-pb-${site.subdomain}`

  // PocketBase service
  services[pbServiceName] = {
    loadBalancer: {
      servers: [{ url: `http://${pbContainerName}:8090` }],
    },
  }

  // PocketBase router for subdomain (higher priority via path prefix)
  routers[`${routerName}-pb`] = {
    rule: `Host(\`${site.subdomain}.${domain}\`) && (PathPrefix(\`/api/\`) || PathPrefix(\`/_/\`))`,
    entryPoints: ["websecure"],
    service: pbServiceName,
    tls: { certResolver: "letsencrypt" },
    priority: 100,
    ...(siteHasOAuth ? { middlewares: ["oauth-errors", "oauth2-proxy-auth", "siteio-authz"] } : {}),
  }

  // PocketBase routers for custom domains
  if (site.domains) {
    for (let i = 0; i < site.domains.length; i++) {
      const customDomain = site.domains[i]!
      routers[`site-${site.subdomain}-cd-${i}-pb`] = {
        rule: `Host(\`${customDomain}\`) && (PathPrefix(\`/api/\`) || PathPrefix(\`/_/\`))`,
        entryPoints: ["websecure"],
        service: pbServiceName,
        tls: { certResolver: "letsencrypt" },
        priority: 100,
        ...(siteHasOAuth ? { middlewares: ["oauth-errors", "oauth2-proxy-auth", "siteio-authz"] } : {}),
      }
    }
  }
}
```

Also clean up: the `generateNginxConfig` method no longer needs the `persistentStorage` check for per-site server blocks (only custom domains need them now). Remove any remaining `persistentStorage` references.

**Step 4: Run tests**

Run: `bun test src/__tests__/unit/traefik-manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/traefik.ts src/__tests__/unit/traefik-manager.test.ts
git commit -m "feat: add PocketBase path-prefix routing in Traefik dynamic config"
```

---

## Task 5: Integrate PocketBaseManager into AgentServer

**Files:**
- Modify: `src/lib/agent/server.ts`

**Step 1: Add PocketBaseManager to the server**

In `server.ts`:
1. Import `PocketBaseManager`
2. Add `private pocketbase: PocketBaseManager` field
3. Initialize in constructor: `this.pocketbase = new PocketBaseManager(config.dataDir)`

**Step 2: Update `handleToggleStorage` to manage containers**

When PocketBase is enabled for a site:
- Call `this.pocketbase.start(subdomain)` to start the container
- Update routing config (existing call)

When PocketBase is disabled:
- Call `this.pocketbase.remove(subdomain)` to stop the container
- Update routing config

```typescript
private async handleToggleStorage(subdomain: string, req: Request): Promise<Response> {
  if (!this.storage.siteExists(subdomain)) {
    return this.error("Site not found", 404)
  }
  try {
    const body = (await req.json()) as { enabled: boolean }

    if (body.enabled) {
      // Start PocketBase container
      await this.pocketbase.start(subdomain)
    } else {
      // Stop PocketBase container (keep data)
      this.pocketbase.remove(subdomain)
    }

    const updated = this.storage.updatePocketBase(subdomain, body.enabled)
    if (!updated) return this.error("Failed to update", 500)

    const allSites = this.storage.listSites()
    this.updateRoutingConfig(allSites)

    return this.json({ pocketbase: body.enabled })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to toggle PocketBase"
    return this.error(message, 500)
  }
}
```

**Step 3: Update `handleUndeploy` to clean up PocketBase**

Replace `this.persistentStorage.deleteSite(subdomain)` with:
```typescript
// Stop PocketBase container and clean up data
this.pocketbase.remove(subdomain)
this.pocketbase.cleanup(subdomain)
```

**Step 4: Update `handleDeploy` for PocketBase flag**

In the deploy handler, when `X-Site-PocketBase: true` header is present:
```typescript
const pocketbaseHeader = req.headers.get("X-Site-PocketBase")
if (pocketbaseHeader === "true") {
  this.storage.updatePocketBase(subdomain, true)
  metadata.pocketbase = true
  await this.pocketbase.start(subdomain)
}
```

**Step 5: Ensure PocketBase containers start on server boot**

In the `start()` method, after starting Traefik, start PocketBase containers for all sites that have it enabled:

```typescript
// Start PocketBase containers for sites that have it enabled
const existingSites = this.storage.listSites()
for (const site of existingSites) {
  if (site.pocketbase && !this.pocketbase.isRunning(site.subdomain)) {
    try {
      await this.pocketbase.start(site.subdomain)
    } catch (err) {
      console.error(`> Failed to start PocketBase for ${site.subdomain}:`, err)
    }
  }
}
```

**Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 7: Commit**

```bash
git add src/lib/agent/server.ts
git commit -m "feat: integrate PocketBaseManager into agent server lifecycle"
```

---

## Task 6: Write E2E tests for PocketBase API

**Files:**
- Create: `src/__tests__/api/pocketbase.test.ts`

**Step 1: Write the E2E test file**

These tests verify the PocketBase toggle API, site lifecycle, and container management. They use `skipTraefik: true` so they can't test actual Traefik routing, but they verify that the server APIs work correctly.

Note: Tests that involve actually starting Docker containers should be in `src/__tests__/integration/`. The API tests here test the HTTP endpoints without Docker (server handles errors gracefully when Docker is unavailable in test).

```typescript
// src/__tests__/api/pocketbase.test.ts
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import type { AgentConfig, ApiResponse, SiteInfo } from "../../types.ts"

async function parseJson<T>(response: Response): Promise<ApiResponse<T>> {
  return response.json() as Promise<ApiResponse<T>>
}

const TEST_PORT = 4573
const TEST_API_KEY = "test-api-key-pocketbase"
const TEST_DOMAIN = "test.local"

function makeZip() {
  return zipSync({
    "index.html": new TextEncoder().encode("<html><head></head><body>Hello</body></html>"),
  })
}

async function deploySite(subdomain: string, pocketbase = false) {
  const zipData = makeZip()
  const headers: Record<string, string> = {
    "X-API-Key": TEST_API_KEY,
    "Content-Type": "application/zip",
  }
  if (pocketbase) {
    headers["X-Site-PocketBase"] = "true"
  }
  return fetch(`http://localhost:${TEST_PORT}/sites/${subdomain}`, {
    method: "POST",
    headers,
    body: zipData,
  })
}

async function deleteSite(subdomain: string) {
  return fetch(`http://localhost:${TEST_PORT}/sites/${subdomain}`, {
    method: "DELETE",
    headers: { "X-API-Key": TEST_API_KEY },
  })
}

describe("API: PocketBase", () => {
  let server: AgentServer
  let dataDir: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-test-pocketbase-"))

    const config: AgentConfig = {
      apiKey: TEST_API_KEY,
      dataDir,
      domain: TEST_DOMAIN,
      maxUploadSize: 50 * 1024 * 1024,
      httpPort: 80,
      httpsPort: 443,
      skipTraefik: true,
      port: TEST_PORT,
    }

    server = new AgentServer(config)
    await server.start()
  })

  afterAll(() => {
    server.stop()
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true })
    }
  })

  describe("Deploy with --pocketbase flag", () => {
    afterEach(async () => {
      await deleteSite("pb-deploy")
    })

    test("should deploy site with pocketbase enabled", async () => {
      const response = await deploySite("pb-deploy", true)
      expect(response.ok).toBe(true)
      const data = await parseJson<SiteInfo>(response)
      expect(data.data?.pocketbase).toBe(true)
    })

    test("should deploy site without pocketbase by default", async () => {
      const response = await deploySite("pb-deploy", false)
      expect(response.ok).toBe(true)
      const data = await parseJson<SiteInfo>(response)
      expect(data.data?.pocketbase).toBeUndefined()
    })

    test("should persist pocketbase flag across redeploys", async () => {
      await deploySite("pb-deploy", true)
      const response = await deploySite("pb-deploy", false)
      expect(response.ok).toBe(true)
      const data = await parseJson<SiteInfo>(response)
      expect(data.data?.pocketbase).toBe(true)
    })

    test("should show pocketbase in site listing", async () => {
      await deploySite("pb-deploy", true)

      const response = await fetch(`http://localhost:${TEST_PORT}/sites`, {
        headers: { "X-API-Key": TEST_API_KEY },
      })
      const data = await parseJson<SiteInfo[]>(response)
      const site = data.data?.find((s) => s.subdomain === "pb-deploy")
      expect(site?.pocketbase).toBe(true)
    })
  })

  describe("PocketBase toggle API", () => {
    beforeEach(async () => {
      await deploySite("pb-toggle")
    })

    afterEach(async () => {
      await deleteSite("pb-toggle")
    })

    test("should toggle pocketbase on", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/sites/pb-toggle/storage`, {
        method: "PATCH",
        headers: {
          "X-API-Key": TEST_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      })
      expect(response.ok).toBe(true)
      const data = await parseJson<{ pocketbase: boolean }>(response)
      expect(data.data?.pocketbase).toBe(true)
    })

    test("should toggle pocketbase off", async () => {
      // Enable first
      await fetch(`http://localhost:${TEST_PORT}/sites/pb-toggle/storage`, {
        method: "PATCH",
        headers: {
          "X-API-Key": TEST_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      })

      // Disable
      const response = await fetch(`http://localhost:${TEST_PORT}/sites/pb-toggle/storage`, {
        method: "PATCH",
        headers: {
          "X-API-Key": TEST_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      })
      expect(response.ok).toBe(true)
    })

    test("should return 404 for non-existent site", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/sites/nonexistent/storage`, {
        method: "PATCH",
        headers: {
          "X-API-Key": TEST_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      })
      expect(response.status).toBe(404)
    })

    test("should require API key", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/sites/pb-toggle/storage`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      })
      expect(response.status).toBe(401)
    })
  })

  describe("Site deletion cleanup", () => {
    test("should clean up pocketbase data when site is deleted", async () => {
      await deploySite("pb-cleanup", true)

      // Verify data dir was created
      const pbDataDir = join(dataDir, "pocketbase", "pb-cleanup")
      expect(existsSync(pbDataDir)).toBe(true)

      // Delete site
      await deleteSite("pb-cleanup")

      // Verify data dir is gone
      expect(existsSync(pbDataDir)).toBe(false)
    })
  })
})
```

**Step 2: Run tests**

Run: `bun test src/__tests__/api/pocketbase.test.ts`
Expected: PASS (some tests may fail if Docker calls fail in test env — those tests should be adjusted to handle Docker unavailability gracefully)

**Step 3: Commit**

```bash
git add src/__tests__/api/pocketbase.test.ts
git commit -m "test: add E2E tests for PocketBase API endpoints"
```

---

## Task 7: Update nginx config (remove storage server blocks)

**Files:**
- Modify: `src/lib/agent/traefik.ts`
- Modify: `src/__tests__/unit/traefik-manager.test.ts`

The nginx config no longer needs per-site server blocks for storage injection. Sites with PocketBase only need Traefik routing (handled in Task 4). Nginx server blocks are still needed for custom domains only.

**Step 1: Update tests**

In `src/__tests__/unit/traefik-manager.test.ts`, update/remove any tests that check for `sub_filter` or `/__storage/` in nginx config. Replace with:

```typescript
test("should not add per-site nginx blocks for pocketbase-only sites", () => {
  const config = manager.generateNginxConfig([
    { subdomain: "mysite", size: 100, deployedAt: "2024-01-01", files: [], pocketbase: true },
  ])
  // Should only have the default regex server block and default_server
  expect(config).not.toContain("server_name mysite.test.local")
})
```

**Step 2: Verify generateNginxConfig is clean**

Ensure the `generateNginxConfig` method only creates per-site server blocks for sites with custom domains (not for pocketbase flag alone).

**Step 3: Run tests**

Run: `bun test src/__tests__/unit/traefik-manager.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/lib/agent/traefik.ts src/__tests__/unit/traefik-manager.test.ts
git commit -m "refactor: clean up nginx config, remove storage-related server blocks"
```

---

## Task 8: Create the PocketBase skill

**Files:**
- Create: `SKILL.md` (or add to existing skill structure)

This is a Claude Code skill that teaches how to use PocketBase from static sites deployed on siteio. It should be placed wherever siteio skills live.

**Step 1: Check existing skill location**

Look at how the `siteio` deploy skill is defined and follow the same pattern for the new skill.

**Step 2: Write the skill**

The skill should cover:
- How to enable PocketBase for a site (`siteio sites set <subdomain> --pocketbase`)
- How to access the admin UI (`https://<subdomain>.<domain>/_/`)
- How to create collections via the admin UI
- How to use the PocketBase JS SDK in your static site
- Common patterns: key-value store, lists, user data
- How PocketBase auth works (separate from siteio OAuth)

The skill content (adjust path to match existing skill structure):

```markdown
# PocketBase Storage for Static Sites

## Enabling PocketBase

```bash
# Enable on an existing site
siteio sites set <subdomain> --pocketbase

# Or enable during deploy
siteio sites deploy ./folder --pocketbase
```

## Admin UI

Once enabled, access the PocketBase admin dashboard at:
```
https://<subdomain>.<domain>/_/
```

On first visit, create an admin account. Use the admin UI to:
- Create collections (tables)
- Define fields and validation rules
- Set API access rules (who can read/write)
- View and manage records

## Using from your static site

### 1. Add the SDK

Include via CDN in your HTML:
```html
<script src="https://unpkg.com/pocketbase@0.25.0/dist/pocketbase.umd.js"></script>
```

Or install via npm:
```bash
npm install pocketbase
```

### 2. Initialize the client

```javascript
// SDK is loaded globally from the CDN
const pb = new PocketBase('');  // Empty string = same origin

// Or with ES modules
import PocketBase from 'pocketbase';
const pb = new PocketBase(window.location.origin);
```

### 3. Common patterns

**Simple key-value storage** (create a collection called `kv` with fields `key` (text, unique) and `value` (text)):
```javascript
// Save
await pb.collection('kv').create({ key: 'theme', value: 'dark' });

// Load
const record = await pb.collection('kv').getFirstListItem(`key = "theme"`);
console.log(record.value); // "dark"

// Update
await pb.collection('kv').update(record.id, { value: 'light' });
```

**High scores** (create a collection called `scores` with fields `name` (text) and `score` (number)):
```javascript
// Add score
await pb.collection('scores').create({ name: 'Player1', score: 9001 });

// Top 10
const top = await pb.collection('scores').getList(1, 10, { sort: '-score' });
```

**Real-time updates** (multi-tab / multi-device sync):
```javascript
pb.collection('scores').subscribe('*', (e) => {
  console.log(e.action); // "create", "update", or "delete"
  console.log(e.record);
  // Update your UI here
});
```

**User data with auth** (PocketBase has built-in auth):
```javascript
// Sign up
await pb.collection('users').create({
  email: 'user@example.com',
  password: 'securepassword',
  passwordConfirm: 'securepassword',
});

// Login
await pb.collection('users').authWithPassword('user@example.com', 'securepassword');

// Now CRUD operations respect per-user API rules
const myData = await pb.collection('notes').getFullList();
```

## Architecture

- Each site gets its own PocketBase instance (separate SQLite DB)
- Data stored at `{dataDir}/pocketbase/{subdomain}/` on the server
- PocketBase runs in a Docker container on the siteio network
- Traefik routes `/api/` and `/_/` to PocketBase, everything else to nginx
- Disabling PocketBase stops the container but preserves data
- Deleting the site removes both the container and data
```

**Step 3: Commit**

```bash
git add <skill-file>
git commit -m "docs: add PocketBase storage skill for static sites"
```

---

## Task 9: Final integration test with Docker

**Files:**
- Create: `src/__tests__/integration/pocketbase.test.ts`

This test requires Docker and actually starts/stops PocketBase containers. It verifies the full lifecycle.

```typescript
// src/__tests__/integration/pocketbase.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { PocketBaseManager } from "../../lib/agent/pocketbase.ts"
import { spawnSync } from "bun"

// Skip if Docker is not available
const dockerAvailable = spawnSync({ cmd: ["docker", "info"], stdout: "pipe", stderr: "pipe" }).exitCode === 0

describe("PocketBase Integration", () => {
  let dataDir: string
  let manager: PocketBaseManager

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-pb-integration-"))
    manager = new PocketBaseManager(dataDir)
  })

  afterAll(() => {
    // Clean up any containers we started
    manager.remove("integration-test")
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true })
    }
  })

  test.skipIf(!dockerAvailable)("should build PocketBase image", () => {
    manager.ensureImage()
    const result = spawnSync({
      cmd: ["docker", "image", "inspect", "siteio-pocketbase:latest"],
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode).toBe(0)
  })

  test.skipIf(!dockerAvailable)("should start and stop PocketBase container", async () => {
    // Ensure network exists
    spawnSync({ cmd: ["docker", "network", "create", "siteio-network"], stdout: "pipe", stderr: "pipe" })

    const containerId = await manager.start("integration-test")
    expect(containerId).toBeTruthy()
    expect(manager.isRunning("integration-test")).toBe(true)

    manager.remove("integration-test")
    expect(manager.isRunning("integration-test")).toBe(false)
  })

  test.skipIf(!dockerAvailable)("should preserve data across restarts", async () => {
    spawnSync({ cmd: ["docker", "network", "create", "siteio-network"], stdout: "pipe", stderr: "pipe" })

    await manager.start("integration-test")

    // Verify data directory exists
    const pbDataPath = manager.dataPath("integration-test")
    expect(existsSync(pbDataPath)).toBe(true)

    // Stop and restart
    manager.remove("integration-test")
    await manager.start("integration-test")
    expect(manager.isRunning("integration-test")).toBe(true)

    // Clean up
    manager.remove("integration-test")
  })
})
```

**Step 1: Run the integration test**

Run: `bun test src/__tests__/integration/pocketbase.test.ts`
Expected: PASS (or skipped if Docker unavailable)

**Step 2: Commit**

```bash
git add src/__tests__/integration/pocketbase.test.ts
git commit -m "test: add PocketBase integration tests with Docker"
```

---

## Task 10: Run full test suite and fix any issues

**Step 1: Typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 2: Run all tests**

Run: `bun test`
Expected: All tests pass

**Step 3: Fix any failures**

Address any remaining issues from the rename or integration changes.

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: fix remaining issues from PocketBase migration"
```

---

## Summary of changes

| File | Action |
|---|---|
| `src/lib/agent/persistent-storage.ts` | DELETE |
| `src/lib/agent/storage-shim.ts` | DELETE |
| `src/__tests__/unit/persistent-storage.test.ts` | DELETE |
| `src/__tests__/api/persistent-storage.test.ts` | DELETE |
| `src/lib/agent/pocketbase.ts` | CREATE |
| `src/__tests__/unit/pocketbase.test.ts` | CREATE |
| `src/__tests__/api/pocketbase.test.ts` | CREATE |
| `src/__tests__/integration/pocketbase.test.ts` | CREATE |
| `src/types.ts` | MODIFY (rename field) |
| `src/lib/agent/storage.ts` | MODIFY (rename method) |
| `src/lib/agent/server.ts` | MODIFY (replace shim with PB manager) |
| `src/lib/agent/traefik.ts` | MODIFY (add PB routing, remove sub_filter) |
| `src/lib/client.ts` | MODIFY (rename method) |
| `src/cli.ts` | MODIFY (rename flags) |
| `src/commands/sites/set.ts` | MODIFY (rename option) |
| `src/commands/sites/deploy.ts` | MODIFY (rename option) |
| `src/commands/sites/info.ts` | MODIFY (rename display) |
| `src/__tests__/unit/traefik-manager.test.ts` | MODIFY (update tests) |
| Skill file | CREATE |

## Future improvements

- **PocketBase version management** — allow specifying PB version per site or globally
- **Admin password auto-setup** — generate admin credentials and store in metadata
- **Backup/restore** — SQLite backup of PocketBase data via siteio CLI
- **Resource limits** — Docker memory/CPU limits on PocketBase containers
- **Health monitoring** — check PocketBase container health, auto-restart on failure
- **PocketBase hooks** — allow sites to define custom PocketBase JS hooks
