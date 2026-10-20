# Stop / start for sites and apps — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `siteio sites stop|start` and `siteio apps start` take a site or app offline (every URL answers 404) and bring it back exactly as it was. While it is stopped, nothing can deploy it.

**Architecture:** Stopping removes the containers and sets the existing `status: "stopped"`. Data, code and history are kept. Each deploy entry point checks the stored status **before** any `try/catch` that writes `status: "failed"`. Starting recreates the containers from the stored config. For apps it uses the image already on the server.

**Tech Stack:** Bun, TypeScript, `bun test` with `FakeRuntime`, Commander CLI, Alpine.js admin UI.

**Spec:** `docs/superpowers/specs/2026-10-20-stop-start-design.md`

## Global Constraints

- Reuse `status: "stopped"` (`ContainerStatus` in `src/types.ts`). Add no new field to `Site` or `App`.
- Refused while stopped: HTTP **409**, reason `"stopped"`, message `"<Site|App> '<name>' is stopped; run 'siteio <sites|apps> start <name>' first"`.
- `<name>` in messages is the name as the caller sees it: `this.tenants.displayName(key, scope)`.
- Stopping never deletes volumes. `docker compose down` in this repo passes `-v` (`compose.ts:149`), so stop needs a new down call without `-v`.
- Share links and edit links may not stop or start.
- Stop and start page pagerio and don't post to ranking.
- CLI: JSON on stdout with `--json`, human-readable text on stderr (spinner and `formatSuccess`).
- Tests are adversarial: each one pins a way the feature could fail, not the happy path only.

## Review Focus

1. **A stopped item whose status gets overwritten.** A gate inside a `try` whose `catch` sets `failed` silently unlocks the item. Every gate test also asserts that the stored status is still `stopped`.
2. **Stopping a compose app deletes its volumes.** The only existing down call uses `-v`. Task 3 pins the exact argv.
3. **A stopped app whose image was pruned can't come back.** `deploy` is refused and `start` has nothing to run. `start` falls back to a full deploy when no image exists (Task 4 test).
4. **A chat turn that is already running when the site is stopped.** Its deploy must still be refused (Task 2 test, with an executor that stops the site mid-turn).
5. **A tenant reaching another tenant's item through the new routes.** It must answer 404, like every other tenant route (Tasks 1 and 4 tests).

## File map

| File | Change |
|---|---|
| `src/lib/agent/server.ts` | Site stop/start handlers, gates, host 404, tenant route regexes, app stop/start/restart, helper extraction |
| `src/lib/agent/compose.ts` | `buildDownKeepVolumesArgs`, `downKeepVolumes` |
| `src/lib/agent/runtime.ts`, `src/lib/agent/docker.ts`, `src/__tests__/helpers/fake-runtime.ts` | `composeDownKeepVolumes` on the `Runtime` interface |
| `src/lib/client.ts` | `stopSite`, `startSite`, `startApp` |
| `src/commands/sites/stop.ts`, `src/commands/sites/start.ts`, `src/commands/apps/start.ts` | New CLI commands (pattern: `src/commands/apps/stop.ts`) |
| `src/commands/sites/upgrade.ts` | `--all` skips stopped sites |
| `src/cli.ts` | Register the three commands |
| `src/lib/agent/ui/ui.js`, `src/lib/agent/ui/index.html` | Buttons |
| `src/lib/skill-content.ts`, `README.md`, `CLAUDE.md` | Docs |
| Tests | `src/__tests__/api/site-stop.test.ts` (new), `src/__tests__/api/apps-stop-start.test.ts` (new), `src/__tests__/api/site-chat.test.ts`, `src/__tests__/api/apps-compose.test.ts`, `src/__tests__/unit/compose-manager.test.ts` |

Run the whole suite and the typecheck after every task:

```bash
bun test && bun run typecheck
```

---

### Task 1: Site stop and start, and the 404 on the site's host

**Files:**
- Modify: `src/lib/agent/server.ts` (routes near the other `/sites/:name/...` routes, about line 590; `TENANT_ROUTE` line 62; host checks at about lines 385 and 423; new handlers next to `handleUpgradeSite`; `pageSite` next to `pageApp`, about line 2791)
- Test: `src/__tests__/api/site-stop.test.ts` (new)

**Interfaces:**
- Produces:
  - `private stoppedMessage(kind: "site" | "app", key: string, scope: Scope): string`
  - `private stoppedError(kind: "site" | "app", key: string, scope: Scope): Response` (409, reason `"stopped"`)
  - `private liveHostContext(host: string): ReturnType<OAuthProvider["hostContext"]>`
  - `private pageSite(site: Site, event: "stopped" | "started", by?: string): void`
  - Routes: `POST /sites/:name/stop`, `POST /sites/:name/start`, both returning `SiteInfo`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/api/site-stop.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { SiteStorage } from "../../lib/agent/storage.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig, ApiResponse, SiteInfo } from "../../types.ts"

const GOD = { "X-API-Key": "test-key" }
const GOD_ZIP = { ...GOD, "Content-Type": "application/zip" }
const GOD_JSON = { ...GOD, "Content-Type": "application/json" }

describe("API: site stop / start", () => {
  let dataDir: string
  let runtime: FakeRuntime
  let server: AgentServer

  const req = (path: string, init: RequestInit = {}, host = "localhost") =>
    server.handleRequestForTest(new Request(`http://x${path}`, init), host)
  const deploy = (name = "blog") =>
    req(`/sites/${name}`, { method: "POST", headers: GOD_ZIP, body: zipSync({ "public/index.html": new TextEncoder().encode("<h1>hi</h1>") }) })
  const stop = (name = "blog") => req(`/sites/${name}/stop`, { method: "POST", headers: GOD })
  const start = (name = "blog") => req(`/sites/${name}/start`, { method: "POST", headers: GOD })
  const stored = (name = "blog") => new SiteStorage(join(dataDir, "data")).get(name)!

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-site-stop-"))
    runtime = new FakeRuntime()
    server = new AgentServer(
      { apiKey: "test-key", dataDir: join(dataDir, "data"), domain: "example.com", maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true } as AgentConfig,
      runtime
    )
    expect((await deploy()).status).toBe(200)
    runtime.containerExistsReturn = true
    runtime.calls = []
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  test("stop removes the container and keeps the site, its code and its version", async () => {
    const before = stored()
    const res = await stop()
    expect(res.status).toBe(200)
    expect(((await res.json()) as ApiResponse<SiteInfo>).data!.status).toBe("stopped")
    expect(runtime.callsOf("remove").map((c) => c.args[0])).toEqual(["blog"])
    expect(runtime.callsOf("stop")).toHaveLength(0) // removed, not stopped: no restart policy can revive it
    expect(stored().status).toBe("stopped")
    expect(stored().version).toBe(before.version)
  })

  test("stopping twice is refused and changes nothing", async () => {
    await stop()
    runtime.calls = []
    const res = await stop()
    expect(res.status).toBe(409)
    expect(runtime.callsOf("remove")).toHaveLength(0)
    expect(stored().status).toBe("stopped")
  })

  test("start on a running site is refused and does not recreate it", async () => {
    const res = await start()
    expect(res.status).toBe(409)
    expect(runtime.callsOf("run")).toHaveLength(0)
  })

  test("start recreates the container with domains and env changed while stopped", async () => {
    await stop()
    runtime.containerExistsReturn = false
    const dom = await req("/sites/blog/domains", { method: "PATCH", headers: GOD_JSON, body: JSON.stringify({ domains: ["blog.acme.test"] }) })
    expect(dom.status).toBe(200)
    const env = await req("/sites/blog/env", { method: "PATCH", headers: GOD_JSON, body: JSON.stringify({ env: { PLAN: "pro" } }) })
    expect(env.status).toBe(200)
    expect(runtime.callsOf("run")).toHaveLength(0) // config changes leave it offline
    expect(stored().status).toBe("stopped")

    const res = await start()
    expect(res.status).toBe(200)
    expect(stored().status).toBe("running")
    const run = runtime.callsOf("run").at(-1)!.args[0] as { env: Record<string, string>; labels: Record<string, string> }
    expect(run.env.PLAN).toBe("pro")
    expect(JSON.stringify(run.labels)).toContain("blog.acme.test")
  })

  test("rename while stopped keeps it offline and stopped", async () => {
    await stop()
    runtime.containerExistsReturn = false
    const res = await req("/sites/blog/rename", { method: "PATCH", headers: GOD_JSON, body: JSON.stringify({ newSubdomain: "journal" }) })
    expect(res.status).toBe(200)
    expect(runtime.callsOf("run")).toHaveLength(0)
    expect(stored("journal").status).toBe("stopped")
  })

  test("a failed start marks the site failed and reports the error", async () => {
    await stop()
    runtime.runError = new Error("port in use")
    const res = await start()
    expect(res.status).toBe(500)
    expect(stored().status).toBe("failed")
  })

  test("the agent's own routes on a stopped site's host answer 404", async () => {
    expect((await req("/_siteio/health", {}, "blog.example.com")).status).toBe(200)
    await stop()
    for (const path of ["/_siteio/health", "/_siteio/edit", "/mcp", "/.well-known/oauth-protected-resource"]) {
      expect((await req(path, {}, "blog.example.com")).status).toBe(404)
    }
  })

  test("unknown site: stop and start answer 404", async () => {
    expect((await stop("nope")).status).toBe(404)
    expect((await start("nope")).status).toBe(404)
  })
})
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `bun test src/__tests__/api/site-stop.test.ts`
Expected: FAIL. Stop and start answer 404, because the routes don't exist yet. The host test fails on the second loop.

- [ ] **Step 3: Implement**

In `server.ts`, add `stop|start` to `TENANT_ROUTE` (line 62):

```ts
const TENANT_ROUTE =
  /^\/(agent|sites|sites\/[a-z0-9-]+(\/(logs|admin|download|thumbnail|history|rollback|upgrade|domains|env|rename|stop|start|grants|grants\/grt_[a-z0-9]+))?)$/
```

Add the routes after the upgrade route (about line 597):

```ts
    // POST /sites/:name/stop - take the site offline (container removed, data kept)
    const siteStopMatch = path.match(/^\/sites\/([a-z0-9-]+)\/stop$/)
    if (siteStopMatch && req.method === "POST") {
      return this.handleStopSite(k(siteStopMatch[1]!), req, scope)
    }

    // POST /sites/:name/start - bring a stopped site back
    const siteStartMatch = path.match(/^\/sites\/([a-z0-9-]+)\/start$/)
    if (siteStartMatch && req.method === "POST") {
      return this.handleStartSite(k(siteStartMatch[1]!), req, scope)
    }
```

Add the helpers and handlers after `handleUpgradeSite`:

```ts
  // A stopped site or app takes no deploy until `start`. Callers check this
  // before any try/catch that marks the item "failed": that would lose it.
  private stoppedMessage(kind: "site" | "app", key: string, scope: Scope): string {
    const shown = this.tenants.displayName(key, scope)
    return `${kind === "site" ? "Site" : "App"} '${shown}' is stopped; run 'siteio ${kind}s start ${shown}' first`
  }

  private stoppedError(kind: "site" | "app", key: string, scope: Scope): Response {
    return this.error(this.stoppedMessage(kind, key, scope), 409, "stopped")
  }

  // Take a site offline: remove its container (code, pb_data and history
  // stay), so Traefik has no route and no restart policy can revive it.
  private async handleStopSite(name: string, req: Request, scope: Scope): Promise<Response> {
    const site = this.storage.get(name)
    if (!site) return this.error("Site not found", 404)
    if (site.status === "stopped") return this.error(`Site '${this.tenants.displayName(name, scope)}' is already stopped`, 409)
    if (!this.docker.isAvailable()) return this.error("Docker is not available", 500)
    try {
      if (this.docker.containerExists(name)) await this.docker.remove(name)
    } catch (err) {
      return this.error(err instanceof Error ? err.message : "Failed to stop site", 500)
    }
    const updated = this.storage.update(name, { status: "stopped", containerId: undefined })!
    this.pageSite(updated, "stopped", this.requestUser(req))
    return this.json(this.storage.toInfo(updated, this.tenants, scope))
  }

  // Bring a stopped site back from its stored record, so domain, env and
  // rename changes made while it was stopped apply now.
  private async handleStartSite(name: string, req: Request, scope: Scope): Promise<Response> {
    const site = this.storage.get(name)
    if (!site) return this.error("Site not found", 404)
    if (site.status !== "stopped") return this.error(`Site '${this.tenants.displayName(name, scope)}' is not stopped`, 409)
    if (!this.docker.isAvailable()) return this.error("Docker is not available", 500)
    try {
      const containerId = await this.startSiteContainer(site)
      const updated = this.storage.update(name, { status: "running", containerId })!
      this.pageSite(updated, "started", this.requestUser(req))
      return this.json(this.storage.toInfo(updated, this.tenants, scope))
    } catch (err) {
      this.storage.update(name, { status: "failed" })
      return this.error(err instanceof Error ? err.message : "Failed to start site", 500)
    }
  }
```

Add `pageSite` next to `pageApp`:

```ts
  private pageSite(site: Site, event: "stopped" | "started", by?: string): void {
    this.pager?.notify({
      title: `Site '${site.name}' ${event}`,
      message: [by && `by ${by}`, `on ${this.config.domain}`].filter(Boolean).join(" · "),
      url: this.storage.toInfo(site, this.tenants).url,
    })
  }
```

Add the host check next to `isDeploying`:

```ts
  // The site a host serves, or null when there is none or it is stopped: a
  // stopped site answers 404 everywhere, the agent's own routes included.
  private liveHostContext(host: string): ReturnType<OAuthProvider["hostContext"]> {
    const ctx = this.oauthProvider.hostContext(host)
    if (!ctx || this.storage.get(ctx.site)?.status === "stopped") return null
    return ctx
  }
```

Replace `this.oauthProvider.hostContext(host)` with `this.liveHostContext(host)` at its two calls in `handleRequest`: the MCP surface (about line 385) and `/_siteio` (about line 423).

- [ ] **Step 4: Run the tests and check that they pass**

Run: `bun test src/__tests__/api/site-stop.test.ts && bun test && bun run typecheck`
Expected: PASS, with no regression.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/server.ts src/__tests__/api/site-stop.test.ts
git commit -m "feat(sites): stop and start a site; a stopped site answers 404"
```

---

### Task 2: Refuse deploys on a stopped site

**Files:**
- Modify: `src/lib/agent/server.ts`: `handleDeploySite` (about line 1936), `handleScopedDeploy` (about line 2110), `deploySiteViaGrant` (about line 2147), `handleSiteChat` (about line 1828), `runRollback` (about line 2553), `handleUpgradeSite` (about line 2470)
- Test: `src/__tests__/api/site-stop.test.ts`, `src/__tests__/api/site-chat.test.ts`

**Interfaces:**
- Consumes: `stoppedMessage` and `stoppedError` from Task 1.

- [ ] **Step 1: Write the failing tests**

Add to the `describe` in `site-stop.test.ts`. Also add `ShareGrantCreated` to the type import.

```ts
  test("deploy, rollback and upgrade on a stopped site are refused and it stays stopped", async () => {
    await deploy() // v2, so v1 exists for the rollback
    await stop()
    runtime.calls = []
    const attempts = [
      await deploy(),
      await req("/sites/blog/rollback", { method: "POST", headers: GOD_JSON, body: JSON.stringify({ version: 1 }) }),
      await req("/sites/blog/upgrade", { method: "POST", headers: GOD }),
    ]
    for (const res of attempts) {
      expect(res.status).toBe(409)
      expect(((await res.json()) as ApiResponse<null>).error).toBe("Site 'blog' is stopped; run 'siteio sites start blog' first")
    }
    expect(runtime.callsOf("run")).toHaveLength(0)
    expect(runtime.callsOf("pull")).toHaveLength(0)
    expect(stored().status).toBe("stopped") // not "failed": the catch blocks never ran
  })

  test("a share code can't deploy, stop or start a stopped site", async () => {
    const grant = await req("/sites/blog/grants", { method: "POST", headers: GOD_JSON, body: "{}" })
    const code = ((await grant.json()) as ApiResponse<ShareGrantCreated>).data!.code
    expect((await req("/sites/blog/stop", { method: "POST", headers: { "X-API-Key": code } })).status).toBe(403)
    await stop()
    expect((await req("/sites/blog/start", { method: "POST", headers: { "X-API-Key": code } })).status).toBe(403)
    const res = await req("/sites/blog", {
      method: "POST",
      headers: { "X-API-Key": code, "Content-Type": "application/zip" },
      body: zipSync({ "public/index.html": new TextEncoder().encode("<h1>x</h1>") }),
    })
    expect(res.status).toBe(409)
    expect(stored().status).toBe("stopped")
  })
```

When the upgrade test runs, the stored `pocketbaseVersion` equals `POCKETBASE_VERSION`. The handler then returns "already current" before reaching the gate. Put the gate **before** the `from === to` check (Step 3), so the test exercises it.

Add to `site-chat.test.ts`, inside `describe("API: site chat")`:

```ts
  test("a chat turn on a stopped site is refused before the LLM runs", async () => {
    let ran = false
    server = makeServer(dataDir, { chat: CHAT, executor: { run: async () => { ran = true; return { finalText: "", isError: false, aborted: false, timedOut: false } } } })
    await deploySite(server, "blog", "<h1>Old</h1>")
    await server.handleRequestForTest(new Request("http://x/sites/blog/stop", { method: "POST", headers: GOD }))
    const res = await server.handleRequestForTest(
      new Request("http://x/sites/blog/chat", { method: "POST", headers: GOD_JSON, body: JSON.stringify({ message: "hi" }) })
    )
    expect(res.status).toBe(409)
    expect(ran).toBe(false)
  })

  test("a site stopped during a chat turn refuses that turn's deploy and stays stopped", async () => {
    const stopper: ChatExecutor = {
      run: async (input) => {
        await server.handleRequestForTest(new Request("http://x/sites/blog/stop", { method: "POST", headers: GOD }))
        writeFileSync(join(input.workspaceDir, "index.html"), "<h1>New</h1>")
        return { finalText: "Done.", isError: false, aborted: false, timedOut: false }
      },
    }
    server = makeServer(dataDir, { chat: CHAT, executor: stopper })
    await deploySite(server, "blog", "<h1>Old</h1>")
    const res = await server.handleRequestForTest(
      new Request("http://x/sites/blog/chat", { method: "POST", headers: GOD_JSON, body: JSON.stringify({ message: "edit" }) })
    )
    await res.text() // drain the SSE stream so the turn finishes
    const site: any = await (await server.handleRequestForTest(new Request("http://x/sites/blog", { headers: GOD }))).json()
    expect(site.data.status).toBe("stopped")
    expect(site.data.version).toBe(1)
  })
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `bun test src/__tests__/api/site-stop.test.ts src/__tests__/api/site-chat.test.ts`
Expected: FAIL. Deploys answer 200 and bring the site back, and the chat turn runs.

- [ ] **Step 3: Implement the gates**

Each gate sits **before** the `try`.

`handleDeploySite`, right after `let site = this.storage.get(name)`:

```ts
    if (site?.status === "stopped") return this.stoppedError("site", name, scope)
```

`handleScopedDeploy`, right after `if (!site) return this.error("Site not found", 404)`:

```ts
    if (site.status === "stopped") return this.stoppedError("site", name, scope)
```

`deploySiteViaGrant`, after the "no longer exists" check (MCP and chat turns both deploy through it):

```ts
    if (site.status === "stopped") throw new Error(this.stoppedMessage("site", siteName, this.tenants.ownerOf(siteName)))
```

`handleSiteChat`, after the "Site not found" check:

```ts
    if (this.storage.get(name)?.status === "stopped") return this.stoppedError("site", name, this.tenants.ownerOf(name))
```

`runRollback`, after "Site not found" (this covers the god route and the edit-link undo):

```ts
    if (site.status === "stopped") return this.stoppedError("site", name, scope)
```

`handleUpgradeSite`, after "Site not found" and **before** `if (from === to)`:

```ts
    if (site.status === "stopped") return this.stoppedError("site", name, scope)
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/server.ts src/__tests__/api/site-stop.test.ts src/__tests__/api/site-chat.test.ts
git commit -m "feat(sites): a stopped site refuses deploys, rollbacks, upgrades and chat turns"
```

---

### Task 3: A compose down that keeps volumes, and helpers extracted from app deploy (no behavior change)

**Files:**
- Modify: `src/lib/agent/compose.ts` (next to `buildDownArgs` and `down`), `src/lib/agent/runtime.ts:59`, `src/lib/agent/docker.ts:469`, `src/__tests__/helpers/fake-runtime.ts:164`
- Modify: `src/lib/agent/server.ts`: `deployComposeApp` (about line 1231) and `deployContainerApp` (about line 1310)
- Test: `src/__tests__/unit/compose-manager.test.ts`

**Interfaces:**
- Produces:
  - `ComposeManager.buildDownKeepVolumesArgs(project, files, envFile?): string[]`
  - `Runtime.composeDownKeepVolumes(project: string, files: string[], envFile?: string): Promise<void>`
  - `private async composeUpApp(app: App): Promise<{ containerId?: string; warnings: string[] }>`: writes the override, runs `compose up`, returns the primary service's container ID and the compose warnings
  - `private async tenantSafeImage(name: string, image: string): Promise<string>`
  - `private async runAppContainer(app: App, image: string): Promise<string>`: replaces the container and returns its ID

- [ ] **Step 1: Write the failing test**

In `compose-manager.test.ts`, next to the `buildDownArgs` tests:

```ts
  test("buildDownKeepVolumesArgs removes containers but never volumes", () => {
    const args = cm.buildDownKeepVolumesArgs("siteio-x", ["/b.yml"], "/e")
    expect(args).toEqual(["compose", "-p", "siteio-x", "-f", "/b.yml", "--env-file", "/e", "down", "--remove-orphans"])
    expect(args).not.toContain("-v")
    expect(args).not.toContain("--volumes")
  })
```

- [ ] **Step 2: Run the test and check that it fails**

Run: `bun test src/__tests__/unit/compose-manager.test.ts`
Expected: FAIL, "buildDownKeepVolumesArgs is not a function".

- [ ] **Step 3: Implement**

`compose.ts`, after `buildDownArgs`:

```ts
  // For `apps stop`: the containers go, named volumes stay for `start`.
  buildDownKeepVolumesArgs(project: string, files: string[], envFile?: string): string[] {
    return [...this.buildBaseArgs(project, files, envFile), "down", "--remove-orphans"]
  }
```

After `down()`:

```ts
  async downKeepVolumes(project: string, files: string[], envFile?: string): Promise<void> {
    const result = spawnSync({
      cmd: ["docker", ...this.buildDownKeepVolumesArgs(project, files, envFile)],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      throw new SiteioError(`docker compose down failed: ${result.stderr.toString()}`)
    }
  }
```

`runtime.ts`, after `composeDown`:

```ts
  composeDownKeepVolumes(project: string, files: string[], envFile?: string): Promise<void>
```

`docker.ts`, after `composeDown`:

```ts
  composeDownKeepVolumes(project: string, files: string[], envFile?: string): Promise<void> {
    return this.compose.downKeepVolumes(project, files, envFile)
  }
```

`fake-runtime.ts`, after `composeDown`:

```ts
  async composeDownKeepVolumes(project: string, files: string[], envFile?: string): Promise<void> {
    this.record("composeDownKeepVolumes", [project, files, envFile])
  }
```

In `server.ts`, extract from `deployComposeApp` everything from `const project = \`siteio-${name}\`` through the `composePs` lookup into:

```ts
  // Write the siteio override for the app's current config and bring the
  // project up. Returns the primary service's container ID. Throws DeployError.
  private async composeUpApp(app: App): Promise<{ containerId?: string; warnings: string[] }> {
    const { name, compose } = app
    if (!compose) throw new DeployError("Not a compose app", 400)
    const project = `siteio-${name}`
    let resolved: { spec: ComposeSpec; warnings: string[] }
    try {
      resolved = await this.resolveComposeBase(app)
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err
      throw new DeployError(err.message, 400)
    }
    const primary = resolved.spec.services[compose.primaryService] as { networks?: Record<string, unknown> }
    const overrideYaml = buildOverride(app, {
      domains: this.appStorage.routedDomains(app, this.tenants),
      baseNetworks: Object.keys(primary.networks ?? {}),
      dataDir: this.config.dataDir,
    })
    this.compose.writeOverride(name, overrideYaml)
    const files = [this.composeBasePath(app), this.compose.overridePath(name)]
    const envFile = this.writeComposeEnvFile(app)
    await this.docker.composeUp(project, files, envFile)
    const ps = await this.docker.composePs(project, files, envFile)
    const containerId = ps.find((s) => s.service === compose.primaryService)?.containerId
    return { containerId, warnings: resolved.warnings }
  }
```

`deployComposeApp` then becomes: ensure the network, clone (git), check `existsSync(basePath)`, `const { containerId, warnings } = await this.composeUpApp(app)`, then the same `appStorage.update` and paging as today. The `catch` stays as it is.

From `deployContainerApp`, extract the tenant block:

```ts
  // Traefik reads the labels baked into an image too: a tenant's image could
  // route any hostname, the operator's API included, to itself. Tenant
  // containers run from the inspected ID, so a concurrent retag can't swap it.
  private async tenantSafeImage(name: string, image: string): Promise<string> {
    if (!this.tenants.ownerOf(name)) return image
    const { id, labels } = await this.docker.imageInspect(image)
    if (Object.keys(labels).some((key) => key.toLowerCase().startsWith("traefik."))) {
      throw new DeployError("Image labels starting with 'traefik.' are not allowed for tenant apps", 400)
    }
    return id
  }

  // Replace the app's container with one running `image`, routed on its
  // domains. Returns the new container ID.
  private async runAppContainer(app: App, image: string): Promise<string> {
    if (this.docker.containerExists(app.name)) await this.docker.remove(app.name)
    const labels = this.docker.buildTraefikLabels(app.name, this.appStorage.routedDomains(app, this.tenants), app.internalPort)
    return this.docker.run({
      name: app.name,
      image,
      internalPort: app.internalPort,
      env: app.env,
      volumes: app.volumes,
      restartPolicy: app.restartPolicy,
      network: "siteio-network",
      labels,
    })
  }
```

In `deployContainerApp`, the middle becomes this, keeping `swapped` after the tenant check and before the removal, as today:

```ts
      imageToRun = await this.tenantSafeImage(name, imageToRun)

      // The new image is ready: only now replace the running container, if
      // the app still exists.
      if (!this.appStorage.get(name)) throw new DeployError("App not found", 404)
      swapped = true
      const containerId = await this.runAppContainer(app, imageToRun)
```

- [ ] **Step 4: Run all the tests and check that they pass**

Run: `bun test && bun run typecheck`
Expected: PASS. `apps-deploy-swap`, `apps-compose` and `tenants` pass unchanged, which proves the refactor kept behavior.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/compose.ts src/lib/agent/runtime.ts src/lib/agent/docker.ts src/lib/agent/server.ts src/__tests__/helpers/fake-runtime.ts src/__tests__/unit/compose-manager.test.ts
git commit -m "refactor(apps): extract compose-up and container-run helpers; add a down that keeps volumes"
```

---

### Task 4: App stop removes, start brings back, restart starts a stopped app, deploy refuses

**Files:**
- Modify: `src/lib/agent/server.ts`: `TENANT_APP_ROUTE` (line 65), app routes (about line 700), `handleStopApp`, `handleRestartApp`, new `handleStartApp` and `startApp`, `handleDeployApp`, the `autoDeployer` `deploy` callback (about line 300), `pageApp` (about line 2791)
- Modify: `src/__tests__/api/apps-compose.test.ts` (lines 183-191 and 391-392)
- Test: `src/__tests__/api/apps-stop-start.test.ts` (new)

**Interfaces:**
- Consumes: `stoppedError` and `stoppedMessage` (Task 1); `composeUpApp`, `tenantSafeImage`, `runAppContainer` and `composeDownKeepVolumes` (Task 3).
- Produces:
  - Route `POST /apps/:name/start`, returning `AppInfo`
  - `private async startApp(app: App, by?: string): Promise<App>`
  - `pageApp` event union `"deployed" | "restarted" | "stopped" | "started"`

The gate for apps sits in `handleDeployApp` and in the auto-deploy callback, **not** inside `deployContainerApp`. That way `startApp` can fall back to a full deploy when the image is gone (Review Focus 3).

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/api/apps-stop-start.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AgentServer } from "../../lib/agent/server"
import { AppStorage } from "../../lib/agent/app-storage"
import { FakeRuntime } from "../helpers/fake-runtime"
import type { AgentConfig, ApiResponse, App } from "../../types"

const API_KEY = "stop-start-test-key"
let dir: string
let runtime: FakeRuntime
let server: AgentServer

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "siteio-stop-start-"))
  runtime = new FakeRuntime()
  const config: AgentConfig = {
    apiKey: API_KEY, dataDir: join(dir, "data"), domain: "stop.test",
    maxUploadSize: 1024 * 1024, httpPort: 80, httpsPort: 443, skipTraefik: true,
  }
  server = new AgentServer(config, runtime)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function call<T>(method: string, path: string, body?: object): Promise<{ status: number; body: ApiResponse<T> }> {
  const res = await server.handleRequestForTest(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "X-API-Key": API_KEY, ...(body && { "Content-Type": "application/json" }) },
      body: body ? JSON.stringify(body) : undefined,
    })
  )
  return { status: res.status, body: (await res.json()) as ApiResponse<T> }
}
const stored = () => new AppStorage(join(dir, "data")).get("web")!

async function deployedImageApp(): Promise<void> {
  expect((await call("POST", "/apps", { name: "web", image: "nginx:alpine", internalPort: 80 })).status).toBe(200)
  expect((await call("POST", "/apps/web/deploy")).status).toBe(200)
  runtime.containerExistsReturn = true
  runtime.imageExistsReturn = true
  runtime.calls = []
}

describe("apps stop", () => {
  test("removes the container instead of stopping it", async () => {
    await deployedImageApp()
    const res = await call<App>("POST", "/apps/web/stop")
    expect(res.status).toBe(200)
    expect(res.body.data!.status).toBe("stopped")
    expect(runtime.callsOf("remove").map((c) => c.args[0])).toEqual(["web"])
    expect(runtime.callsOf("stop")).toHaveLength(0)
  })

  test("stopping twice is refused", async () => {
    await deployedImageApp()
    await call("POST", "/apps/web/stop")
    runtime.calls = []
    expect((await call("POST", "/apps/web/stop")).status).toBe(409)
    expect(runtime.callsOf("remove")).toHaveLength(0)
  })
})

describe("apps start", () => {
  test("recreates the container from the image on the server, with no pull or build", async () => {
    await deployedImageApp()
    await call("POST", "/apps/web/stop")
    runtime.containerExistsReturn = false
    await call("PATCH", "/apps/web", { env: { PLAN: "pro" } })
    expect(runtime.callsOf("run")).toHaveLength(0) // a config change leaves it offline
    runtime.calls = []

    const res = await call<App>("POST", "/apps/web/start")
    expect(res.status).toBe(200)
    expect(stored().status).toBe("running")
    expect(runtime.callsOf("pull")).toHaveLength(0)
    expect(runtime.callsOf("build")).toHaveLength(0)
    const run = runtime.callsOf("run")[0]!.args[0] as { image: string; env: Record<string, string> }
    expect(run.image).toBe("nginx:alpine")
    expect(run.env.PLAN).toBe("pro")
  })

  test("with the image gone, start falls back to a full deploy instead of leaving the app stuck", async () => {
    await deployedImageApp()
    await call("POST", "/apps/web/stop")
    runtime.imageExistsReturn = false
    const res = await call<App>("POST", "/apps/web/start")
    expect(res.status).toBe(200)
    expect(runtime.callsOf("pull")).toHaveLength(1)
    expect(stored().status).toBe("running")
  })

  test("start on a running app is refused", async () => {
    await deployedImageApp()
    expect((await call("POST", "/apps/web/start")).status).toBe(409)
    expect(runtime.callsOf("run")).toHaveLength(0)
  })

  test("a failed start marks the app failed", async () => {
    await deployedImageApp()
    await call("POST", "/apps/web/stop")
    runtime.runError = new Error("port in use")
    expect((await call("POST", "/apps/web/start")).status).toBe(500)
    expect(stored().status).toBe("failed")
  })
})

describe("while stopped", () => {
  test("deploy is refused and the app stays stopped", async () => {
    await deployedImageApp()
    await call("POST", "/apps/web/stop")
    runtime.calls = []
    const res = await call("POST", "/apps/web/deploy")
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("App 'web' is stopped; run 'siteio apps start web' first")
    expect(runtime.callsOf("pull")).toHaveLength(0)
    expect(stored().status).toBe("stopped")
  })

  test("restart starts it, like start", async () => {
    await deployedImageApp()
    await call("POST", "/apps/web/stop")
    runtime.containerExistsReturn = false
    runtime.calls = []
    const res = await call<App>("POST", "/apps/web/restart")
    expect(res.status).toBe(200)
    expect(stored().status).toBe("running")
    expect(runtime.callsOf("restart")).toHaveLength(0) // there is no container to restart
    expect(runtime.callsOf("run")).toHaveLength(1)
  })
})
```

In `apps-compose.test.ts`, replace the test "stop invokes composeStop, not docker.stop" (lines 183-191) with:

```ts
    test("stop removes the project's containers and keeps its volumes", async () => {
      await setup("stopapp")
      const r = await req("POST", "/apps/stopapp/stop")
      const app = await jsonOk<App>(r)
      expect(app.status).toBe("stopped")
      expect(runtime.callsOf("composeDownKeepVolumes")[0]!.args[0]).toBe("siteio-stopapp")
      expect(runtime.callsOf("composeDown")).toHaveLength(0) // that one passes -v
      expect(runtime.callsOf("composeStop")).toHaveLength(0)
    })

    test("start brings the project up again without cloning", async () => {
      await setup("startapp")
      await req("POST", "/apps/startapp/stop")
      runtime.calls = []
      const app = await jsonOk<App>(await req("POST", "/apps/startapp/start"))
      expect(app.status).toBe("running")
      expect(runtime.callsOf("composeUp")).toHaveLength(1)
    })
```

In the "stop/restart/delete/logs thread siteio.env through" test (lines 391-395), change `composeStop` to `composeDownKeepVolumes`. The following restart now starts a stopped app, so its call is `composeUp`, not `composeRestart`:

```ts
      await req("POST", "/apps/lifecycleenv/stop")
      expect(runtime.callsOf("composeDownKeepVolumes")[0]!.args[2]).toBe(expectedEnvPath)

      await req("POST", "/apps/lifecycleenv/restart")
      expect(runtime.callsOf("composeUp")[0]!.args[2]).toBe(expectedEnvPath)
```

In `tenants.test.ts`, test "a tenant can't reach an app outside its scope" (about line 476): add `["POST", "/start"]` to `calls`.

- [ ] **Step 2: Run the tests and check that they fail**

Run: `bun test src/__tests__/api/apps-stop-start.test.ts src/__tests__/api/apps-compose.test.ts src/__tests__/api/tenants.test.ts`
Expected: FAIL. Stop calls `stop`/`composeStop`, `/start` answers 404, and deploy succeeds.

- [ ] **Step 3: Implement**

`TENANT_APP_ROUTE` (line 65):

```ts
const TENANT_APP_ROUTE = /^\/apps(\/[a-z0-9-]+(\/(deploy|stop|start|restart|logs|status|thumbnail))?)?$/
```

Routes (about line 700). Pass `req` to stop, and add start:

```ts
    // POST /apps/:name/stop - take the app offline (containers removed, volumes kept)
    const appStopMatch = path.match(/^\/apps\/([a-z0-9-]+)\/stop$/)
    if (appStopMatch && req.method === "POST") {
      return this.handleStopApp(k(appStopMatch[1]!), req, scope)
    }

    // POST /apps/:name/start - bring a stopped app back
    const appStartMatch = path.match(/^\/apps\/([a-z0-9-]+)\/start$/)
    if (appStartMatch && req.method === "POST") {
      return this.handleStartApp(k(appStartMatch[1]!), req, scope)
    }
```

`handleDeployApp`, right after "App not found":

```ts
    if (app.status === "stopped") return this.stoppedError("app", name, scope)
```

Auto-deploy callback (about line 300). It already skips stopped apps; this closes the race with a stop that lands mid-poll:

```ts
        deploy: async (name, ref) => {
          if (this.appStorage.get(name)?.status === "stopped") throw new DeployError(this.stoppedMessage("app", name, null), 409)
          await this.deployContainerApp(name, { ref })
        },
```

Replace `handleStopApp`:

```ts
  // Take an app offline: remove its containers (volumes and config stay), so
  // Traefik has no route and no restart policy, compose's included, revives it.
  private async handleStopApp(name: string, req: Request, scope: Scope): Promise<Response> {
    const app = this.appStorage.get(name)
    if (!app) {
      return this.error("App not found", 404)
    }
    if (app.status === "stopped") return this.error(`App '${this.tenants.displayName(name, scope)}' is already stopped`, 409)
    if (this.isDeploying(name)) {
      return this.error("Deploy already in progress", 409)
    }
    try {
      if (app.compose) {
        const files = this.composeFiles(app)
        await this.docker.composeDownKeepVolumes(`siteio-${name}`, files, this.writeComposeEnvFile(app))
      } else if (this.docker.containerExists(name)) {
        await this.docker.remove(name)
      }
      const updated = this.appStorage.update(name, { status: "stopped", containerId: undefined })!
      this.pageApp(updated, "stopped", this.requestUser(req))
      return this.json(this.appView(updated, scope))
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to stop app"
      return this.error(message, 500)
    }
  }
```

Add `startApp` and `handleStartApp` after it:

```ts
  // Bring a stopped app back from its stored config and the image already on
  // the server: no build, no pull. With no image left (never built, or
  // pruned), fall back to a full deploy rather than leave it stuck.
  private async startApp(app: App, by?: string): Promise<App> {
    if (!this.docker.isAvailable()) throw new DeployError("Docker is not available", 500)
    this.docker.ensureNetwork()
    const image = app.git || app.dockerfile ? this.docker.imageTag(app.name) : app.image
    if (!app.compose && !this.docker.imageExists(image)) return this.deployContainerApp(app.name, { deployedBy: by })
    try {
      const containerId = app.compose
        ? (await this.composeUpApp(app)).containerId
        : await this.runAppContainer(app, await this.tenantSafeImage(app.name, image))
      const updated = this.appStorage.update(app.name, { status: "running", containerId })
      if (!updated) throw new DeployError("App not found", 404)
      this.pageApp(updated, "started", by)
      return updated
    } catch (err) {
      this.appStorage.update(app.name, { status: "failed" })
      if (err instanceof DeployError) throw err
      throw new DeployError(err instanceof Error ? err.message : "Failed to start app", 500)
    }
  }

  private async handleStartApp(name: string, req: Request, scope: Scope): Promise<Response> {
    const app = this.appStorage.get(name)
    if (!app) return this.error("App not found", 404)
    if (app.status !== "stopped") return this.error(`App '${this.tenants.displayName(name, scope)}' is not stopped`, 409)
    if (this.isDeploying(name)) return this.error("Deploy already in progress", 409)
    try {
      const updated = await this.startApp(app, this.requestUser(req))
      return this.json(this.appView(updated, scope))
    } catch (err) {
      const status = err instanceof DeployError ? err.status : 500
      return this.error(err instanceof Error ? err.message : "Failed to start app", status)
    }
  }
```

`handleRestartApp`, right after the `isDeploying` check:

```ts
    if (app.status === "stopped") return this.handleStartApp(name, req, scope)
```

`pageApp` signature:

```ts
  private pageApp(app: App, event: "deployed" | "restarted" | "stopped" | "started", by?: string): void {
```

The ranking report stays under `if (event === "deployed")`.

- [ ] **Step 4: Run all the tests and check that they pass**

Run: `bun test && bun run typecheck`
Expected: PASS. `apps-secrets` "deploy, stop and restart responses are scrubbed" still passes, because stop returns `appView`. `tenants` "a tenant uses its own app…" calls stop, then restart: restart now starts the app and still answers 200.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/server.ts src/__tests__/api/apps-stop-start.test.ts src/__tests__/api/apps-compose.test.ts src/__tests__/api/tenants.test.ts
git commit -m "feat(apps): stop removes containers, start brings them back, deploy refuses a stopped app"
```

---

### Task 5: CLI and client

**Files:**
- Modify: `src/lib/client.ts` (after `upgradeSite`, about line 152, and after `restartApp`, about line 404)
- Create: `src/commands/sites/stop.ts`, `src/commands/sites/start.ts`, `src/commands/apps/start.ts`
- Modify: `src/cli.ts` (after `sites upgrade`, about line 225; after `apps stop`, about line 427)
- Modify: `src/commands/sites/upgrade.ts`

**Interfaces:**
- Consumes: the routes from Tasks 1 and 4.
- Produces: `SiteioClient.stopSite(name): Promise<SiteInfo>`, `SiteioClient.startSite(name): Promise<SiteInfo>`, `SiteioClient.startApp(name): Promise<AppInfo>`.

- [ ] **Step 1: Client methods**

In `client.ts`, after `upgradeSite`:

```ts
  async stopSite(name: string): Promise<SiteInfo> {
    const response = await this.request<ApiResponse<SiteInfo>>("POST", `/sites/${name}/stop`)
    if (!response.data) throw new ApiError("Invalid response from server")
    return response.data
  }

  async startSite(name: string): Promise<SiteInfo> {
    const response = await this.request<ApiResponse<SiteInfo>>("POST", `/sites/${name}/start`)
    if (!response.data) throw new ApiError("Invalid response from server")
    return response.data
  }
```

After `restartApp`:

```ts
  async startApp(name: string): Promise<AppInfo> {
    const response = await this.request<ApiResponse<AppInfo>>("POST", `/apps/${name}/start`)
    if (!response.data) {
      throw new ApiError("Invalid response from server")
    }
    return response.data
  }
```

- [ ] **Step 2: Commands**

Create `src/commands/apps/start.ts`, a copy of `src/commands/apps/stop.ts` with these changes:
- the function is `startAppCommand`;
- the spinner says `Starting app ${name}` / `Started app ${name}`;
- it calls `client.startApp(name)`;
- the final message is `App ${chalk.bold(name)} started.`, with the status in `chalk.green`.

Create `src/commands/sites/stop.ts`:

```ts
import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { resolveSiteName } from "../../utils/site-config.ts"

export async function sitesStopCommand(
  name: string | undefined,
  options: { json?: boolean } = {}
): Promise<void> {
  const spinner = ora()

  try {
    const resolved = resolveSiteName(name, getCurrentServer()?.domain ?? "")
    if (!resolved) {
      throw new ValidationError("Site name required. Provide as argument or run from a directory with .siteio/config.json")
    }
    if (!name) {
      console.error(chalk.dim(`Using site '${resolved}' from .siteio/config.json`))
    }
    name = resolved

    spinner.start(`Stopping site ${name}`)
    const site = await new SiteioClient().stopSite(name)
    spinner.succeed(`Stopped site ${name}`)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: site }, null, 2))
    } else {
      console.error("")
      console.error(formatSuccess(`Site ${chalk.bold(name)} stopped. ${site.url} now answers 404.`))
      console.error(chalk.dim(`  Bring it back with: siteio sites start ${name}`))
      console.error("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
```

Create `src/commands/sites/start.ts`, the same file with:
- `sitesStartCommand`;
- `Starting site` / `Started site`;
- `client.startSite(name)`;
- the final message `Site ${chalk.bold(name)} started: ${site.url}`, with no hint line.

The existing `apps stop` prints its readable output with `console.log`. The new site commands use `console.error` for readable text, following the dual-output rule in CLAUDE.md. Don't change `apps/stop.ts`.

- [ ] **Step 3: Register them in `cli.ts`**

After `sites upgrade`:

```ts
  sites
    .command("stop [name]")
    .description("Take a site offline (404) without deleting it; bring it back with 'start'")
    .action(async (name) => {
      const { sitesStopCommand } = await import("./commands/sites/stop.ts")
      await sitesStopCommand(name, { json: program.opts().json })
    })

  sites
    .command("start [name]")
    .description("Bring a stopped site back online, as it was")
    .action(async (name) => {
      const { sitesStartCommand } = await import("./commands/sites/start.ts")
      await sitesStartCommand(name, { json: program.opts().json })
    })
```

After `apps stop`, change its description to `"Take an app offline (containers removed, volumes kept); bring it back with 'start'"` and add:

```ts
apps
  .command("start [name]")
  .description("Bring a stopped app back online with the image already on the server")
  .action(async (name) => {
    const { startAppCommand } = await import("./commands/apps/start.ts")
    await startAppCommand(name, { json: program.opts().json })
  })
```

- [ ] **Step 4: `sites upgrade --all` skips stopped sites**

In `src/commands/sites/upgrade.ts`, replace the `--all` branch:

```ts
    let skipped: string[] = []
    if (options.all) {
      if (name) throw new ValidationError("Pass either a site name or --all, not both")
      const sites = await client.listSites()
      skipped = sites.filter((s) => s.status === "stopped").map((s) => s.name)
      names = sites.filter((s) => s.status !== "stopped").map((s) => s.name)
      for (const s of skipped) console.error(chalk.dim(`${s}: stopped, skipped`))
      if (names.length === 0) throw new ValidationError(skipped.length ? "Every site is stopped; nothing to upgrade" : "No sites to upgrade")
    } else {
```

Move `let skipped` above the `if`, so it is in scope later. In the JSON output, add `skipped`:

```ts
      console.log(JSON.stringify({ success: failed.length === 0, data: outcomes, skipped }, null, 2))
```

In the summary line, add `, ${skipped.length} stopped (skipped)` when `skipped.length > 0`.

- [ ] **Step 5: Check by hand**

Run: `bun run typecheck && bun test`
Then: `bun run start sites --help` and `bun run start apps --help`.
Expected: `stop` and `start` are listed under `sites`, and `start` under `apps`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/client.ts src/commands/sites/stop.ts src/commands/sites/start.ts src/commands/apps/start.ts src/commands/sites/upgrade.ts src/cli.ts
git commit -m "feat(cli): siteio sites stop|start and apps start; upgrade --all skips stopped sites"
```

---

### Task 6: Admin UI buttons

**Files:**
- Modify: `src/lib/agent/ui/ui.js` (next to `stopApp`, about line 666; next to `undeploySite`, about line 722)
- Modify: `src/lib/agent/ui/index.html` (app tools, about lines 457-470; site tools, about lines 627-633)

- [ ] **Step 1: `ui.js`**

After `restartApp`:

```js
    async startApp(name) {
      await this._runAction(name, "start", "POST", `/apps/${encodeURIComponent(name)}/start`, `App ${name} started`)
      await this.loadApp(name)
    },
```

Add `|| this.pending.has("start")` to `anyAppActionPending`.

Before `undeploySite`:

```js
    async stopSite(name) {
      if (!confirm(`Stop site '${name}'? It answers 404 until you start it again. Nothing is deleted.`)) return
      await this._runAction(name, "site-stop", "POST", `/sites/${encodeURIComponent(name)}/stop`, `Site ${name} stopped`)
      await this.loadSite(name)
    },

    async startSite(name) {
      await this._runAction(name, "site-start", "POST", `/sites/${encodeURIComponent(name)}/start`, `Site ${name} started`)
      await this.loadSite(name)
    },
```

- [ ] **Step 2: `index.html`**

In the app tools, wrap Stop and Restart and add Start:

```html
                  <template x-if="selectedApp?.status !== 'stopped'">
                    <span class="tools">
                      <button :disabled="anyAppActionPending()" @click="stopApp(route.param)" class="button">
                        <i class="hgi hgi-stroke hgi-stop-circle"></i> Stop
                      </button>
                      <button :disabled="anyAppActionPending()" @click="restartApp(route.param)" class="button">
                        <i class="hgi hgi-stroke hgi-reload"></i> Restart
                      </button>
                    </span>
                  </template>
                  <template x-if="selectedApp?.status === 'stopped'">
                    <button :disabled="anyAppActionPending()" @click="startApp(route.param)" class="button">
                      <i class="hgi hgi-stroke hgi-reload"></i> Start
                    </button>
                  </template>
```

In the site tools, before Remove:

```html
                  <template x-if="selectedSite?.status !== 'stopped'">
                    <button :disabled="pending.has('site-stop')" @click="stopSite(route.param)" class="button">
                      <i class="hgi hgi-stroke hgi-stop-circle"></i> Stop
                    </button>
                  </template>
                  <template x-if="selectedSite?.status === 'stopped'">
                    <button :disabled="pending.has('site-start')" @click="startSite(route.param)" class="button">
                      <i class="hgi hgi-stroke hgi-reload"></i> Start
                    </button>
                  </template>
```

`icons.css` is a small subset with no play icon, so Start uses `hgi-reload` (Restart is hidden while stopped, so the two never show together). Check that the `<span class="tools">` wrapper doesn't break the toolbar layout in `ui.css`. If it does, use two `<template>` blocks, one per button.

- [ ] **Step 3: Check it in the real UI**

Run a local agent with Docker, `SITEIO_DOMAIN` set and an API key. Open the admin page, then:
1. On a deployed site, click Stop: the badge shows `stopped` and the Start button appears.
2. Click Start: the badge shows `running`.
3. Do the same with an app.

Use the `run` skill or a browser. Stub-only tests are not enough here, because UI paths have broken before without the stubs noticing.

Run: `bun test src/__tests__/api/admin-ui-routes.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/agent/ui/ui.js src/lib/agent/ui/index.html
git commit -m "feat(ui): stop and start buttons for sites, start for apps"
```

---

### Task 7: Docs

**Files:**
- Modify: `src/lib/skill-content.ts` (sites list about line 205; apps "Lifecycle" line 257)
- Modify: `README.md` (about lines 368-377)
- Modify: `CLAUDE.md` (Features list)

- [ ] **Step 1: Write the docs**

`skill-content.ts`, sites list, after the Rename line:

```
- **Stop / start**: \`siteio sites stop\` takes the site offline (404) and keeps everything; \`siteio sites start\` brings it back as it was. While stopped, deploys, rollbacks, chat and share links are refused
```

Apps, replace the Lifecycle line:

```
- **Lifecycle**: \`siteio apps stop|start|restart|rm myapp\`. \`stop\` removes the containers (volumes kept) and the URL answers 404; \`start\` (or \`restart\`) brings back the same image. A stopped app refuses \`deploy\`: start it first
```

`README.md`: after "Restart an app", add:

```
# Bring a stopped app back (same image, no rebuild)
siteio apps start myapp

# Take a site offline (404) and bring it back
siteio sites stop mysite
siteio sites start mysite
```

`CLAUDE.md`, Features, after the "Custom domains, history/rollback, rename" bullet:

```
- **Stop / start**: `siteio sites stop|start`, `siteio apps stop|start` take a site or app offline (404, containers removed, data kept) and bring it back as it was; a stopped item refuses deploys until started
```

- [ ] **Step 2: Check and commit**

Run: `bun test && bun run typecheck`
Expected: PASS. Skill-content tests, if any, still pass.

```bash
git add src/lib/skill-content.ts README.md CLAUDE.md
git commit -m "docs: stop and start for sites and apps"
```

---

### Task 8: Before release

- [ ] Search the Mac app (plosson/siteio-app) for calls to `/deploy` on apps that might be stopped, and for `/stop` (its behavior changed). Report what you find. Don't change that repo in this plan.
- [ ] Release notes for the version bump:
  - `apps deploy` on a stopped app now fails; use `apps start` (or `apps restart`) first.
  - `apps stop` removes the containers. Volumes are kept.
  - Apps already stopped on servers are affected.
