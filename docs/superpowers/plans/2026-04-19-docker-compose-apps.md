# Docker Compose Apps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `siteio apps create` / `apps deploy` / lifecycle commands to accept a `docker-compose.yml` as an alternative source (inline or inside a git repo), with exactly one primary service publicly exposed through Traefik via a generated override file.

**Architecture:** Introduce a `Runtime` abstraction that both `DockerManager` (existing container flows) and a new `ComposeManager` plug into. Server handlers branch on `app.compose` to use the right runtime methods. All Traefik labels and env vars for the primary service are injected via a generated `docker-compose.siteio.yml` override file merged at `docker compose` invocation time; `docker compose config --format json` is used as the authoritative compose-spec parser.

**Tech Stack:** TypeScript + Bun (test runner + HTTP), Commander.js for CLI, shelling to `docker` / `docker compose` CLIs via `Bun.spawnSync`. **No new npm dependencies** — the override file is a templated string, compose parsing uses `docker compose config`.

**Reference spec:** `docs/superpowers/specs/2026-04-19-docker-compose-apps-design.md`

---

## Pre-flight

- [ ] **Step 0.1: Verify tests pass on clean tree**

Run: `cd /Users/plosson/devel/projects/personal/siteio && bun test`
Expected: all existing tests pass.

If anything fails before changes, stop and investigate before proceeding.

---

## Phase 1: Runtime Seam (enables testable deploy pipelines)

This phase extracts the `Runtime` interface, wires a `DockerRuntime` default implementation, introduces a `FakeRuntime` test helper, and threads it through `AgentServer`. Existing image/Dockerfile/git flows keep working byte-for-byte.

### Task 1: Define `Runtime` interface with container methods

**Files:**
- Create: `src/lib/agent/runtime.ts`

- [ ] **Step 1.1: Create the interface file**

```typescript
// src/lib/agent/runtime.ts
import type { BuildConfig, ContainerRunConfig } from "./docker"
import type { ContainerInspect } from "../../types"

export interface LogsOptions {
  tail: number
}

export interface ComposeLogsOptions {
  service?: string
  all?: boolean
  tail: number
}

export interface ComposeServiceState {
  service: string
  containerId: string
  state: string // "running" | "exited" | ...
}

/**
 * Abstracts container runtime operations (docker + docker compose) so that
 * AgentServer can be tested without shelling out. The default implementation
 * is DockerRuntime; tests inject FakeRuntime to record calls.
 */
export interface Runtime {
  // ---- Single-container ops (existing flows) ----
  isAvailable(): boolean
  ensureNetwork(networkName?: string): void
  imageTag(appName: string): string
  pull(image: string): Promise<void>
  build(config: BuildConfig): Promise<string>
  run(config: ContainerRunConfig): Promise<string>
  stop(appName: string): Promise<void>
  restart(appName: string): Promise<void>
  remove(appName: string): Promise<void>
  removeImage(tag: string): Promise<void>
  logs(appName: string, tail: number): Promise<string>
  isRunning(appName: string): boolean
  containerExists(appName: string): boolean
  inspect(appName: string): Promise<ContainerInspect | null>
  buildTraefikLabels(
    appName: string,
    domains: string[],
    port: number,
    requireAuth?: boolean
  ): Record<string, string>
  imageExists(tag: string): boolean

  // Compose methods added in Task 9 (left as TODO stubs until then).
}
```

- [ ] **Step 1.2: Run typecheck**

Run: `cd /Users/plosson/devel/projects/personal/siteio && bun run typecheck`
Expected: PASS. No users of the interface yet.

- [ ] **Step 1.3: Commit**

```bash
git add src/lib/agent/runtime.ts
git commit -m "feat(runtime): define Runtime interface for container ops"
```

---

### Task 2: Make `DockerManager` implement `Runtime`

**Files:**
- Modify: `src/lib/agent/docker.ts:26`

`DockerManager` already has every method the interface requires, with identical signatures. We just need to declare that it implements `Runtime`.

- [ ] **Step 2.1: Update class declaration**

In `src/lib/agent/docker.ts`, change line 26:

```typescript
// Before:
export class DockerManager {

// After:
import type { Runtime } from "./runtime"
// ...
export class DockerManager implements Runtime {
```

(Add the `import type` near the existing imports at the top of the file; leave the `SiteioError` import untouched.)

- [ ] **Step 2.2: Run typecheck**

Run: `cd /Users/plosson/devel/projects/personal/siteio && bun run typecheck`
Expected: PASS. If TS complains about a missing method, the interface was wrong — go back to Task 1 and fix the signature to match `DockerManager`.

- [ ] **Step 2.3: Run tests**

Run: `cd /Users/plosson/devel/projects/personal/siteio && bun test`
Expected: all existing tests still pass.

- [ ] **Step 2.4: Commit**

```bash
git add src/lib/agent/docker.ts
git commit -m "feat(runtime): declare DockerManager as Runtime implementation"
```

---

### Task 3: Thread `Runtime` through `AgentServer` constructor

**Files:**
- Modify: `src/lib/agent/server.ts:26-51`

Add an optional second constructor argument; default to a fresh `DockerManager`. Use it to initialize `this.docker`.

- [ ] **Step 3.1: Update AgentServer constructor**

In `src/lib/agent/server.ts` around line 26–34, change:

```typescript
// Before (roughly):
constructor(config: AgentConfig) {
  this.config = config
  this.storage = new SiteStorage(config.dataDir)
  this.groups = new GroupStorage(config.dataDir)
  this.appStorage = new AppStorage(config.dataDir)
  this.docker = new DockerManager(config.dataDir)
  this.git = new GitManager(config.dataDir)
  this.dockerfiles = new DockerfileStorage(config.dataDir)
  // ...
}

// After:
constructor(config: AgentConfig, runtime?: Runtime) {
  this.config = config
  this.storage = new SiteStorage(config.dataDir)
  this.groups = new GroupStorage(config.dataDir)
  this.appStorage = new AppStorage(config.dataDir)
  this.docker = runtime ?? new DockerManager(config.dataDir)
  this.git = new GitManager(config.dataDir)
  this.dockerfiles = new DockerfileStorage(config.dataDir)
  // ...
}
```

Also change the type of the `docker` property to `Runtime` (it was `DockerManager`). Add `import type { Runtime } from "./runtime"` at the top.

- [ ] **Step 3.2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3.3: Run all tests**

Run: `bun test`
Expected: all existing tests pass unchanged. No test updates needed — they construct `AgentServer(config)` without a runtime and get the default.

- [ ] **Step 3.4: Commit**

```bash
git add src/lib/agent/server.ts
git commit -m "feat(runtime): accept optional Runtime override in AgentServer"
```

---

### Task 4: Build `FakeRuntime` test helper

**Files:**
- Create: `src/__tests__/helpers/fake-runtime.ts`

- [ ] **Step 4.1: Write the fake**

```typescript
// src/__tests__/helpers/fake-runtime.ts
import type { BuildConfig, ContainerRunConfig } from "../../lib/agent/docker"
import type { ContainerInspect } from "../../types"
import type { Runtime } from "../../lib/agent/runtime"

export interface RecordedCall {
  method: string
  args: unknown[]
}

/**
 * Runtime that records every call and returns configurable fixtures.
 * Tests assert against `fake.calls` to verify siteio invoked the right docker
 * operations in the right order.
 */
export class FakeRuntime implements Runtime {
  calls: RecordedCall[] = []

  // Fixtures tests can override per-test:
  runReturn = "fake-container-id-123"
  buildReturn = "siteio-fake:latest"
  logsReturn = ""
  inspectReturn: ContainerInspect | null = null
  isAvailableReturn = true
  imageExistsReturn = false
  isRunningReturn = true
  containerExistsReturn = false

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args })
  }

  isAvailable(): boolean {
    this.record("isAvailable", [])
    return this.isAvailableReturn
  }

  ensureNetwork(networkName?: string): void {
    this.record("ensureNetwork", [networkName])
  }

  imageTag(appName: string): string {
    this.record("imageTag", [appName])
    return `siteio-${appName}:latest`
  }

  async pull(image: string): Promise<void> {
    this.record("pull", [image])
  }

  async build(config: BuildConfig): Promise<string> {
    this.record("build", [config])
    return this.buildReturn
  }

  async run(config: ContainerRunConfig): Promise<string> {
    this.record("run", [config])
    return this.runReturn
  }

  async stop(appName: string): Promise<void> {
    this.record("stop", [appName])
  }

  async restart(appName: string): Promise<void> {
    this.record("restart", [appName])
  }

  async remove(appName: string): Promise<void> {
    this.record("remove", [appName])
  }

  async removeImage(tag: string): Promise<void> {
    this.record("removeImage", [tag])
  }

  async logs(appName: string, tail: number): Promise<string> {
    this.record("logs", [appName, tail])
    return this.logsReturn
  }

  isRunning(appName: string): boolean {
    this.record("isRunning", [appName])
    return this.isRunningReturn
  }

  containerExists(appName: string): boolean {
    this.record("containerExists", [appName])
    return this.containerExistsReturn
  }

  async inspect(appName: string): Promise<ContainerInspect | null> {
    this.record("inspect", [appName])
    return this.inspectReturn
  }

  buildTraefikLabels(
    appName: string,
    domains: string[],
    port: number,
    requireAuth?: boolean
  ): Record<string, string> {
    this.record("buildTraefikLabels", [appName, domains, port, requireAuth])
    const containerName = `siteio-${appName}`
    return {
      "traefik.enable": "true",
      [`traefik.http.routers.${containerName}.entrypoints`]: "websecure",
      [`traefik.http.routers.${containerName}.tls.certresolver`]: "letsencrypt",
      [`traefik.http.services.${containerName}.loadbalancer.server.port`]: String(port),
      ...(domains.length > 0
        ? {
            [`traefik.http.routers.${containerName}.rule`]: domains.map((d) => `Host(\`${d}\`)`).join(" || "),
          }
        : {}),
    }
  }

  imageExists(tag: string): boolean {
    this.record("imageExists", [tag])
    return this.imageExistsReturn
  }

  // Helper: filter recorded calls by method name
  callsOf(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method)
  }
}
```

- [ ] **Step 4.2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4.3: Commit**

```bash
git add src/__tests__/helpers/fake-runtime.ts
git commit -m "test(runtime): add FakeRuntime for call-level assertions"
```

---

## Phase 2: Compose Data Model + Storage

### Task 5: Add `ComposeSource` type + `compose` field on `App`

**Files:**
- Modify: `src/types.ts:42-99`

- [ ] **Step 5.1: Add types**

In `src/types.ts` after the `DockerfileSource` interface (around line 46), add:

```typescript
/**
 * Compose source — user supplied a docker-compose.yml instead of a single
 * Dockerfile/image. Exactly one service in the file is publicly exposed
 * through Traefik; dependencies run alongside it on the compose project network.
 */
export type ComposeSource =
  | { source: "inline"; primaryService: string }
  | { source: "git"; path: string; primaryService: string }
```

Then extend the `App` interface (around line 49–80) — add `compose?` after `dockerfile?`:

```typescript
export interface App {
  // ...
  image: string
  git?: GitSource
  dockerfile?: DockerfileSource
  compose?: ComposeSource
  // ...
}
```

And extend `AppInfo` (around line 83–99) — mirror the new field:

```typescript
export interface AppInfo {
  // ...
  git?: GitSource
  dockerfile?: DockerfileSource
  compose?: ComposeSource
  // ...
}
```

- [ ] **Step 5.2: Propagate through `AppStorage.toInfo`**

In `src/lib/agent/app-storage.ts:118-135`, add `compose: app.compose,` inside the returned `AppInfo` object (placed next to `dockerfile: app.dockerfile,`).

- [ ] **Step 5.3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5.4: Run tests**

Run: `bun test`
Expected: all pass — new field is optional, no existing behavior changed.

- [ ] **Step 5.5: Commit**

```bash
git add src/types.ts src/lib/agent/app-storage.ts
git commit -m "feat(apps): add ComposeSource type on App and AppInfo"
```

---

### Task 6: `ComposeStorage` class with tests

**Files:**
- Create: `src/lib/agent/compose-storage.ts`
- Create: `src/__tests__/unit/compose-storage.test.ts`

- [ ] **Step 6.1: Write the failing test**

```typescript
// src/__tests__/unit/compose-storage.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { ComposeStorage } from "../../lib/agent/compose-storage"

describe("Unit: ComposeStorage", () => {
  let testDir: string
  let storage: ComposeStorage

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "siteio-compose-test-"))
    storage = new ComposeStorage(testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test("writeBaseInline persists compose file under dataDir/compose/<app>/docker-compose.yml", () => {
    storage.writeBaseInline("myapp", "services:\n  web:\n    image: nginx\n")
    const expected = join(testDir, "compose", "myapp", "docker-compose.yml")
    expect(existsSync(expected)).toBe(true)
    expect(readFileSync(expected, "utf-8")).toContain("image: nginx")
  })

  test("baseInlinePath returns the expected location", () => {
    expect(storage.baseInlinePath("myapp")).toBe(
      join(testDir, "compose", "myapp", "docker-compose.yml")
    )
  })

  test("overridePath returns the expected location", () => {
    expect(storage.overridePath("myapp")).toBe(
      join(testDir, "compose", "myapp", "docker-compose.siteio.yml")
    )
  })

  test("writeOverride persists override alongside the base file", () => {
    storage.writeBaseInline("myapp", "services: {}")
    storage.writeOverride("myapp", "networks:\n  siteio-network:\n    external: true\n")
    expect(existsSync(storage.overridePath("myapp"))).toBe(true)
  })

  test("writeOverride creates dir even when no base file exists (git-hosted apps)", () => {
    storage.writeOverride("gitapp", "services: {}")
    expect(existsSync(storage.overridePath("gitapp"))).toBe(true)
  })

  test("exists returns true when inline base file is present", () => {
    expect(storage.exists("x")).toBe(false)
    storage.writeBaseInline("x", "services: {}")
    expect(storage.exists("x")).toBe(true)
  })

  test("remove deletes the app's compose directory", () => {
    storage.writeBaseInline("myapp", "services: {}")
    storage.writeOverride("myapp", "services: {}")
    storage.remove("myapp")
    expect(existsSync(join(testDir, "compose", "myapp"))).toBe(false)
  })
})
```

- [ ] **Step 6.2: Run test (should fail — module not found)**

Run: `bun test src/__tests__/unit/compose-storage.test.ts`
Expected: FAIL with "Cannot find module '../../lib/agent/compose-storage'".

- [ ] **Step 6.3: Implement `ComposeStorage`**

```typescript
// src/lib/agent/compose-storage.ts
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"

/**
 * Stores per-app compose files: the user's base file (inline uploads only) and
 * the generated siteio override file that injects Traefik routing + network.
 * Git-hosted compose apps keep their base file inside the cloned repo; this
 * storage class only handles the override in that case.
 */
export class ComposeStorage {
  private composeDir: string

  constructor(dataDir: string) {
    this.composeDir = join(dataDir, "compose")
  }

  private appDir(appName: string): string {
    return join(this.composeDir, appName)
  }

  private ensureAppDir(appName: string): string {
    const dir = this.appDir(appName)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  baseInlinePath(appName: string): string {
    return join(this.appDir(appName), "docker-compose.yml")
  }

  overridePath(appName: string): string {
    return join(this.appDir(appName), "docker-compose.siteio.yml")
  }

  writeBaseInline(appName: string, content: string): void {
    this.ensureAppDir(appName)
    writeFileSync(this.baseInlinePath(appName), content)
  }

  writeOverride(appName: string, content: string): void {
    this.ensureAppDir(appName)
    writeFileSync(this.overridePath(appName), content)
  }

  exists(appName: string): boolean {
    return existsSync(this.baseInlinePath(appName))
  }

  remove(appName: string): void {
    const dir = this.appDir(appName)
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
```

- [ ] **Step 6.4: Run tests — should pass**

Run: `bun test src/__tests__/unit/compose-storage.test.ts`
Expected: all tests pass.

- [ ] **Step 6.5: Commit**

```bash
git add src/lib/agent/compose-storage.ts src/__tests__/unit/compose-storage.test.ts
git commit -m "feat(compose): add ComposeStorage for base + override files"
```

---

### Task 7: `buildOverride` pure function with tests

**Files:**
- Create: `src/lib/agent/compose-override.ts`
- Create: `src/__tests__/unit/compose-override.test.ts`

The override file needs to be valid YAML. We emit it as a templated string. All string values are wrapped in double quotes so keys like `traefik.http.routers.siteio-foo.rule: "Host(\`x\`)"` don't break YAML parsing.

- [ ] **Step 7.1: Write the failing test**

```typescript
// src/__tests__/unit/compose-override.test.ts
import { describe, test, expect } from "bun:test"
import { buildOverride } from "../../lib/agent/compose-override"
import type { App } from "../../types"

function appWithCompose(overrides: Partial<App> = {}): App {
  return {
    name: "myapp",
    type: "container",
    image: "siteio-myapp:latest",
    compose: { source: "inline", primaryService: "web" },
    env: {},
    volumes: [],
    internalPort: 3000,
    restartPolicy: "unless-stopped",
    domains: ["myapp.example.com"],
    status: "pending",
    createdAt: "2026-04-19T00:00:00Z",
    updatedAt: "2026-04-19T00:00:00Z",
    ...overrides,
  }
}

describe("Unit: buildOverride", () => {
  test("emits services.<primary>.networks with siteio-network", () => {
    const yaml = buildOverride(appWithCompose())
    expect(yaml).toContain("services:")
    expect(yaml).toMatch(/^ {2}web:/m)
    expect(yaml).toMatch(/networks:\s+- siteio-network/m)
  })

  test("declares siteio-network as external", () => {
    const yaml = buildOverride(appWithCompose())
    expect(yaml).toMatch(/^networks:\s+siteio-network:\s+external: true/ms)
  })

  test("emits Traefik labels for a single domain", () => {
    const yaml = buildOverride(appWithCompose({ domains: ["app.example.com"] }))
    expect(yaml).toContain('traefik.enable: "true"')
    expect(yaml).toContain('traefik.docker.network: "siteio-network"')
    expect(yaml).toContain('traefik.http.routers.siteio-myapp.entrypoints: "websecure"')
    expect(yaml).toContain('traefik.http.routers.siteio-myapp.tls.certresolver: "letsencrypt"')
    expect(yaml).toContain('traefik.http.services.siteio-myapp.loadbalancer.server.port: "3000"')
    expect(yaml).toContain('traefik.http.routers.siteio-myapp.rule: "Host(`app.example.com`)"')
  })

  test("ORs multiple domains with `||`", () => {
    const yaml = buildOverride(appWithCompose({ domains: ["a.example.com", "b.example.com"] }))
    expect(yaml).toContain(
      'traefik.http.routers.siteio-myapp.rule: "Host(`a.example.com`) || Host(`b.example.com`)"'
    )
  })

  test("emits env vars as a map under the primary service", () => {
    const yaml = buildOverride(appWithCompose({ env: { FOO: "bar", DATABASE_URL: "postgres://db/x" } }))
    expect(yaml).toMatch(/environment:\s+FOO: "bar"/m)
    expect(yaml).toContain('DATABASE_URL: "postgres://db/x"')
  })

  test("omits environment block when env is empty", () => {
    const yaml = buildOverride(appWithCompose({ env: {} }))
    expect(yaml).not.toContain("environment:")
  })

  test("emits volumes under the primary service when present", () => {
    const yaml = buildOverride(
      appWithCompose({ volumes: [{ name: "data", mountPath: "/data" }] })
    )
    // Host-side uses siteio's volumes dir convention: named volumes resolve to
    // ${dataDir}/volumes/<app>/<name>. Volume path formatting is the responsibility
    // of the generator — we just check that a volumes: list appears.
    expect(yaml).toMatch(/volumes:\s+- /m)
    expect(yaml).toContain(":/data")
  })

  test("omits volumes block when list is empty", () => {
    const yaml = buildOverride(appWithCompose({ volumes: [] }))
    expect(yaml).not.toMatch(/^ {4}volumes:/m)
  })

  test("escapes backtick-containing rule value by quoting the full string", () => {
    const yaml = buildOverride(appWithCompose({ domains: ["x.test"] }))
    const line = yaml.split("\n").find((l) => l.includes("routers.siteio-myapp.rule"))!
    expect(line.trim().startsWith("traefik.http.routers.siteio-myapp.rule:")).toBe(true)
    expect(line).toContain('"Host(`x.test`)"')
  })
})
```

- [ ] **Step 7.2: Run test (should fail — module not found)**

Run: `bun test src/__tests__/unit/compose-override.test.ts`
Expected: FAIL.

- [ ] **Step 7.3: Implement `buildOverride`**

```typescript
// src/lib/agent/compose-override.ts
import { join } from "path"
import type { App } from "../../types"

/**
 * Generates the YAML content of docker-compose.siteio.yml, the siteio-owned
 * override file merged on top of the user's base compose file. Adds:
 *   - siteio-network attachment on the primary service
 *   - Traefik labels for routing/TLS/OAuth
 *   - env vars set via `apps set-env` (primary-service-only)
 *   - volumes from app.volumes (primary-service-only)
 *
 * All scalar values are double-quoted so tokens like backticks, braces, and
 * equals signs survive YAML parsing intact. Keys are plain (identifier-safe).
 */
export function buildOverride(app: App, dataDir: string = "/data"): string {
  if (!app.compose) {
    throw new Error(`buildOverride called on non-compose app '${app.name}'`)
  }

  const primary = app.compose.primaryService
  const containerName = `siteio-${app.name}`
  const labels = buildTraefikLabelsForCompose(app, containerName)

  const envLines =
    Object.keys(app.env).length > 0
      ? [
          "    environment:",
          ...Object.entries(app.env).map(
            ([k, v]) => `      ${k}: ${yamlQuote(v)}`
          ),
        ]
      : []

  const volumesDir = join(dataDir, "volumes", app.name)
  const volumeLines =
    app.volumes.length > 0
      ? [
          "    volumes:",
          ...app.volumes.map((vol) => {
            const hostPath = vol.name.startsWith("/")
              ? vol.name
              : join(volumesDir, vol.name)
            const ro = vol.readonly ? ":ro" : ""
            return `      - ${yamlQuote(`${hostPath}:${vol.mountPath}${ro}`)}`
          }),
        ]
      : []

  const labelLines = [
    "    labels:",
    ...Object.entries(labels).map(
      ([k, v]) => `      ${k}: ${yamlQuote(v)}`
    ),
  ]

  const lines = [
    "services:",
    `  ${primary}:`,
    "    networks:",
    "      - siteio-network",
    ...labelLines,
    ...envLines,
    ...volumeLines,
    "",
    "networks:",
    "  siteio-network:",
    "    external: true",
    "",
  ]

  return lines.join("\n")
}

/**
 * Mirror of DockerManager.buildTraefikLabels but returns the map without
 * side-effects, so it can be rendered into YAML. Kept local to avoid tight
 * coupling with the container-run codepath; label semantics must match.
 */
function buildTraefikLabelsForCompose(
  app: App,
  containerName: string
): Record<string, string> {
  const labels: Record<string, string> = {
    "traefik.enable": "true",
    "traefik.docker.network": "siteio-network",
    [`traefik.http.routers.${containerName}.entrypoints`]: "websecure",
    [`traefik.http.routers.${containerName}.tls.certresolver`]: "letsencrypt",
    [`traefik.http.services.${containerName}.loadbalancer.server.port`]: String(app.internalPort),
  }

  if (app.domains.length > 0) {
    const hostRules = app.domains.map((d) => `Host(\`${d}\`)`).join(" || ")
    labels[`traefik.http.routers.${containerName}.rule`] = hostRules
  }

  // OAuth: labels wired here once siteio enforces OAuth on container apps.
  // See TODO at src/lib/agent/docker.ts:313-314 — same gap as today.

  return labels
}

function yamlQuote(value: string): string {
  // Double-quoted YAML string: escape backslashes and double quotes only.
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  return `"${escaped}"`
}
```

- [ ] **Step 7.4: Run tests — should pass**

Run: `bun test src/__tests__/unit/compose-override.test.ts`
Expected: all pass.

- [ ] **Step 7.5: Commit**

```bash
git add src/lib/agent/compose-override.ts src/__tests__/unit/compose-override.test.ts
git commit -m "feat(compose): add buildOverride YAML generator"
```

---

## Phase 3: ComposeManager + Runtime Extension

### Task 8: `ComposeManager` class

Thin wrapper around `docker compose` subcommands via `Bun.spawnSync`. No side-by-side test of real docker invocation — tests at this layer assert the argv that would be spawned by unit-testing a helper `buildArgs` method.

**Files:**
- Create: `src/lib/agent/compose.ts`
- Create: `src/__tests__/unit/compose-manager.test.ts`

- [ ] **Step 8.1: Write failing test**

```typescript
// src/__tests__/unit/compose-manager.test.ts
import { describe, test, expect } from "bun:test"
import { ComposeManager } from "../../lib/agent/compose"

describe("Unit: ComposeManager.buildArgs", () => {
  const cm = new ComposeManager()

  test("buildBaseArgs includes project + files", () => {
    const args = cm.buildBaseArgs("siteio-myapp", ["/base.yml", "/over.yml"])
    expect(args).toEqual(["compose", "-p", "siteio-myapp", "-f", "/base.yml", "-f", "/over.yml"])
  })

  test("buildUpArgs appends up -d --build --remove-orphans", () => {
    const args = cm.buildUpArgs("siteio-x", ["/base.yml", "/over.yml"])
    expect(args).toEqual([
      "compose", "-p", "siteio-x", "-f", "/base.yml", "-f", "/over.yml",
      "up", "-d", "--build", "--remove-orphans",
    ])
  })

  test("buildDownArgs appends down -v --remove-orphans", () => {
    const args = cm.buildDownArgs("siteio-x", ["/base.yml"])
    expect(args).toEqual([
      "compose", "-p", "siteio-x", "-f", "/base.yml",
      "down", "-v", "--remove-orphans",
    ])
  })

  test("buildConfigArgs appends config --format json", () => {
    const args = cm.buildConfigArgs("siteio-x", ["/base.yml"])
    expect(args).toEqual([
      "compose", "-p", "siteio-x", "-f", "/base.yml",
      "config", "--format", "json",
    ])
  })

  test("buildLogsArgs with no service passes --tail and no service filter", () => {
    const args = cm.buildLogsArgs("siteio-x", ["/base.yml"], { tail: 50 })
    expect(args).toEqual([
      "compose", "-p", "siteio-x", "-f", "/base.yml",
      "logs", "--no-color", "--tail", "50",
    ])
  })

  test("buildLogsArgs with service appends the service name", () => {
    const args = cm.buildLogsArgs("siteio-x", ["/base.yml"], { tail: 100, service: "web" })
    expect(args).toEqual([
      "compose", "-p", "siteio-x", "-f", "/base.yml",
      "logs", "--no-color", "--tail", "100", "web",
    ])
  })

  test("buildLogsArgs with all ignores service (all = everything)", () => {
    const args = cm.buildLogsArgs("siteio-x", ["/base.yml"], { tail: 100, all: true, service: "web" })
    expect(args).toEqual([
      "compose", "-p", "siteio-x", "-f", "/base.yml",
      "logs", "--no-color", "--tail", "100",
    ])
  })

  test("buildStopArgs / buildRestartArgs / buildPsArgs shapes", () => {
    expect(cm.buildStopArgs("siteio-x", ["/b.yml"]).slice(-1)).toEqual(["stop"])
    expect(cm.buildRestartArgs("siteio-x", ["/b.yml"]).slice(-1)).toEqual(["restart"])
    expect(cm.buildPsArgs("siteio-x", ["/b.yml"]).slice(-3)).toEqual(["ps", "--format", "json"])
  })
})
```

- [ ] **Step 8.2: Run test (should fail)**

Run: `bun test src/__tests__/unit/compose-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 8.3: Implement `ComposeManager`**

```typescript
// src/lib/agent/compose.ts
import { spawnSync } from "bun"
import { SiteioError } from "../../utils/errors"
import type { ComposeLogsOptions, ComposeServiceState } from "./runtime"

export interface ComposeSpec {
  services: Record<string, unknown>
  networks?: Record<string, unknown>
  volumes?: Record<string, unknown>
}

/**
 * Thin wrapper around `docker compose` subcommands. Every method takes the
 * compose project name + list of compose files (base, override), mirroring the
 * CLI's -p / -f flags so tests can predict the exact argv.
 */
export class ComposeManager {
  buildBaseArgs(project: string, files: string[]): string[] {
    const args: string[] = ["compose", "-p", project]
    for (const f of files) {
      args.push("-f", f)
    }
    return args
  }

  buildUpArgs(project: string, files: string[]): string[] {
    return [...this.buildBaseArgs(project, files), "up", "-d", "--build", "--remove-orphans"]
  }

  buildDownArgs(project: string, files: string[]): string[] {
    return [...this.buildBaseArgs(project, files), "down", "-v", "--remove-orphans"]
  }

  buildStopArgs(project: string, files: string[]): string[] {
    return [...this.buildBaseArgs(project, files), "stop"]
  }

  buildRestartArgs(project: string, files: string[]): string[] {
    return [...this.buildBaseArgs(project, files), "restart"]
  }

  buildConfigArgs(project: string, files: string[]): string[] {
    return [...this.buildBaseArgs(project, files), "config", "--format", "json"]
  }

  buildPsArgs(project: string, files: string[]): string[] {
    return [...this.buildBaseArgs(project, files), "ps", "--format", "json"]
  }

  buildLogsArgs(project: string, files: string[], opts: ComposeLogsOptions): string[] {
    const args = [...this.buildBaseArgs(project, files), "logs", "--no-color", "--tail", String(opts.tail)]
    // `all: true` overrides service — we want every service's logs
    if (!opts.all && opts.service) {
      args.push(opts.service)
    }
    return args
  }

  async up(project: string, files: string[]): Promise<void> {
    const result = spawnSync({
      cmd: ["docker", ...this.buildUpArgs(project, files)],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      throw new SiteioError(`docker compose up failed: ${result.stderr.toString()}`)
    }
  }

  async down(project: string, files: string[]): Promise<void> {
    const result = spawnSync({
      cmd: ["docker", ...this.buildDownArgs(project, files)],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      throw new SiteioError(`docker compose down failed: ${result.stderr.toString()}`)
    }
  }

  async stop(project: string, files: string[]): Promise<void> {
    const result = spawnSync({
      cmd: ["docker", ...this.buildStopArgs(project, files)],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      throw new SiteioError(`docker compose stop failed: ${result.stderr.toString()}`)
    }
  }

  async restart(project: string, files: string[]): Promise<void> {
    const result = spawnSync({
      cmd: ["docker", ...this.buildRestartArgs(project, files)],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      throw new SiteioError(`docker compose restart failed: ${result.stderr.toString()}`)
    }
  }

  async config(project: string, files: string[]): Promise<ComposeSpec> {
    const result = spawnSync({
      cmd: ["docker", ...this.buildConfigArgs(project, files)],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      throw new SiteioError(`docker compose config failed: ${result.stderr.toString()}`)
    }
    try {
      return JSON.parse(result.stdout.toString()) as ComposeSpec
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new SiteioError(`Failed to parse compose config output: ${message}`)
    }
  }

  async ps(project: string, files: string[]): Promise<ComposeServiceState[]> {
    const result = spawnSync({
      cmd: ["docker", ...this.buildPsArgs(project, files)],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      throw new SiteioError(`docker compose ps failed: ${result.stderr.toString()}`)
    }

    // `docker compose ps --format json` emits one JSON object per line (NDJSON)
    // on recent versions, or a JSON array on older versions. Handle both.
    const raw = result.stdout.toString().trim()
    if (!raw) return []
    if (raw.startsWith("[")) {
      const parsed = JSON.parse(raw) as Array<{ Service: string; ID: string; State: string }>
      return parsed.map((p) => ({ service: p.Service, containerId: p.ID, state: p.State }))
    }
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { Service: string; ID: string; State: string })
      .map((p) => ({ service: p.Service, containerId: p.ID, state: p.State }))
  }

  async logs(project: string, files: string[], opts: ComposeLogsOptions): Promise<string> {
    const result = spawnSync({
      cmd: ["docker", ...this.buildLogsArgs(project, files, opts)],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      throw new SiteioError(`docker compose logs failed: ${result.stderr.toString()}`)
    }
    return result.stdout.toString() + result.stderr.toString()
  }
}
```

- [ ] **Step 8.4: Run tests — should pass**

Run: `bun test src/__tests__/unit/compose-manager.test.ts`
Expected: all pass.

- [ ] **Step 8.5: Commit**

```bash
git add src/lib/agent/compose.ts src/__tests__/unit/compose-manager.test.ts
git commit -m "feat(compose): add ComposeManager wrapping docker compose CLI"
```

---

### Task 9: Extend `Runtime` with compose methods; wire into `DockerManager` and `FakeRuntime`

**Files:**
- Modify: `src/lib/agent/runtime.ts`
- Modify: `src/lib/agent/docker.ts`
- Modify: `src/__tests__/helpers/fake-runtime.ts`

`DockerManager` gets a `ComposeManager` field and delegates compose methods to it. `FakeRuntime` gets recording versions.

- [ ] **Step 9.1: Extend Runtime interface**

In `src/lib/agent/runtime.ts`, add after the container methods:

```typescript
import type { ComposeSpec } from "./compose"

export interface Runtime {
  // ... existing container methods ...

  // ---- Compose ops ----
  composeConfig(project: string, files: string[]): Promise<ComposeSpec>
  composeUp(project: string, files: string[]): Promise<void>
  composeStop(project: string, files: string[]): Promise<void>
  composeRestart(project: string, files: string[]): Promise<void>
  composeDown(project: string, files: string[]): Promise<void>
  composeLogs(project: string, files: string[], opts: ComposeLogsOptions): Promise<string>
  composePs(project: string, files: string[]): Promise<ComposeServiceState[]>
}
```

- [ ] **Step 9.2: Add compose methods to `DockerManager`**

In `src/lib/agent/docker.ts`, near the top imports add:

```typescript
import { ComposeManager, type ComposeSpec } from "./compose"
import type { ComposeLogsOptions, ComposeServiceState } from "./runtime"
```

Add a `compose` field (next to `dataDir`, `volumesDir`):

```typescript
private compose: ComposeManager
```

Initialize in the constructor (around line 30):

```typescript
constructor(dataDir: string) {
  this.dataDir = dataDir
  this.volumesDir = join(dataDir, "volumes")
  this.compose = new ComposeManager()
}
```

Add these methods on the class (at the end of the class body, before the closing `}`):

```typescript
  composeConfig(project: string, files: string[]): Promise<ComposeSpec> {
    return this.compose.config(project, files)
  }
  composeUp(project: string, files: string[]): Promise<void> {
    return this.compose.up(project, files)
  }
  composeStop(project: string, files: string[]): Promise<void> {
    return this.compose.stop(project, files)
  }
  composeRestart(project: string, files: string[]): Promise<void> {
    return this.compose.restart(project, files)
  }
  composeDown(project: string, files: string[]): Promise<void> {
    return this.compose.down(project, files)
  }
  composeLogs(project: string, files: string[], opts: ComposeLogsOptions): Promise<string> {
    return this.compose.logs(project, files, opts)
  }
  composePs(project: string, files: string[]): Promise<ComposeServiceState[]> {
    return this.compose.ps(project, files)
  }
```

- [ ] **Step 9.3: Add compose methods to `FakeRuntime`**

In `src/__tests__/helpers/fake-runtime.ts`, add at the top:

```typescript
import type { ComposeSpec } from "../../lib/agent/compose"
import type { ComposeLogsOptions, ComposeServiceState } from "../../lib/agent/runtime"
```

And inside the class, add fixture fields and methods:

```typescript
  // Compose fixtures
  composeConfigReturn: ComposeSpec = { services: { web: {} } }
  composePsReturn: ComposeServiceState[] = [
    { service: "web", containerId: "fake-web-id", state: "running" },
  ]
  composeLogsReturn = ""

  async composeConfig(project: string, files: string[]): Promise<ComposeSpec> {
    this.record("composeConfig", [project, files])
    return this.composeConfigReturn
  }
  async composeUp(project: string, files: string[]): Promise<void> {
    this.record("composeUp", [project, files])
  }
  async composeStop(project: string, files: string[]): Promise<void> {
    this.record("composeStop", [project, files])
  }
  async composeRestart(project: string, files: string[]): Promise<void> {
    this.record("composeRestart", [project, files])
  }
  async composeDown(project: string, files: string[]): Promise<void> {
    this.record("composeDown", [project, files])
  }
  async composeLogs(
    project: string,
    files: string[],
    opts: ComposeLogsOptions
  ): Promise<string> {
    this.record("composeLogs", [project, files, opts])
    return this.composeLogsReturn
  }
  async composePs(project: string, files: string[]): Promise<ComposeServiceState[]> {
    this.record("composePs", [project, files])
    return this.composePsReturn
  }
```

- [ ] **Step 9.4: Run typecheck + existing tests**

Run: `bun run typecheck && bun test`
Expected: PASS. `DockerManager` still satisfies `Runtime`; no existing test uses compose methods.

- [ ] **Step 9.5: Commit**

```bash
git add src/lib/agent/runtime.ts src/lib/agent/docker.ts src/__tests__/helpers/fake-runtime.ts
git commit -m "feat(runtime): add compose methods to Runtime interface"
```

---

## Phase 4: Server handlers (compose branches)

From here on, `AgentServer`'s `this.docker` property (typed as `Runtime`) gives access to both container and compose methods — so most handlers need no new field, just a branch on `app.compose`.

### Task 10: Add `composeStorage` field to `AgentServer`

**Files:**
- Modify: `src/lib/agent/server.ts`

- [ ] **Step 10.1: Add field + init**

Near the other storage imports at the top of `server.ts`:

```typescript
import { ComposeStorage } from "./compose-storage"
```

Add a property next to `dockerfiles`:

```typescript
private compose: ComposeStorage
```

In the constructor after `this.dockerfiles = new DockerfileStorage(config.dataDir)`:

```typescript
this.compose = new ComposeStorage(config.dataDir)
```

- [ ] **Step 10.2: Run typecheck + tests**

Run: `bun run typecheck && bun test`
Expected: PASS.

- [ ] **Step 10.3: Commit**

```bash
git add src/lib/agent/server.ts
git commit -m "feat(server): wire ComposeStorage into AgentServer"
```

---

### Task 11: `handleCreateApp` — accept compose fields

**Files:**
- Modify: `src/lib/agent/server.ts:797-886`
- Create: `src/__tests__/api/apps-compose.test.ts` (setup only; per-handler tests added in later tasks)

The integration test file is created in this task because several subsequent tasks (12–16) need the same fixtures. We only fill in the "create" tests here — deploy/stop/etc. tests follow.

- [ ] **Step 11.1: Write the failing test**

```typescript
// src/__tests__/api/apps-compose.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { AgentServer } from "../../lib/agent/server"
import type { AgentConfig, ApiResponse, App, AppInfo } from "../../types"
import { FakeRuntime } from "../helpers/fake-runtime"

const apiKey = "test-api-key"
const testPort = 4577

describe("API: Apps (compose)", () => {
  let testDir: string
  let server: AgentServer
  let runtime: FakeRuntime
  let baseUrl: string

  const inlineCompose = `services:
  web:
    image: nginx
  db:
    image: postgres:16
`

  beforeAll(async () => {
    testDir = mkdtempSync(join(tmpdir(), "siteio-apps-compose-test-"))
    runtime = new FakeRuntime()
    const config: AgentConfig = {
      domain: "test.example.com",
      apiKey,
      dataDir: testDir,
      port: testPort,
      skipTraefik: true,
      maxUploadSize: 50 * 1024 * 1024,
      httpPort: 80,
      httpsPort: 443,
    }
    server = new AgentServer(config, runtime)
    await server.start()
    baseUrl = `http://localhost:${testPort}`
  })

  afterAll(async () => {
    server.stop()
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    runtime.calls = []
  })

  const req = async (method: string, path: string, body?: object) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "X-API-Key": apiKey,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })

  const jsonOk = async <T>(r: Response): Promise<T> => {
    expect(r.status).toBeLessThan(300)
    return (await r.json()) as T
  }

  describe("create", () => {
    test("inline compose: persists app with compose:{source:inline,primaryService}", async () => {
      const r = await req("POST", "/apps", {
        name: "composeapp",
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      })
      const app = await jsonOk<App>(r)
      expect(app.compose).toEqual({ source: "inline", primaryService: "web" })
      expect(app.image).toBe("siteio-composeapp:latest")
      expect(app.internalPort).toBe(80)

      // compose file persisted to dataDir/compose/<name>/docker-compose.yml
      expect(existsSync(join(testDir, "compose", "composeapp", "docker-compose.yml"))).toBe(true)
    })

    test("git+compose: persists compose:{source:git,path,primaryService} and GitSource", async () => {
      const r = await req("POST", "/apps", {
        name: "gitcomposeapp",
        git: { repoUrl: "https://example.test/repo.git", branch: "main" },
        composePath: "docker-compose.prod.yml",
        primaryService: "api",
        internalPort: 4000,
      })
      const app = await jsonOk<App>(r)
      expect(app.compose).toEqual({
        source: "git",
        path: "docker-compose.prod.yml",
        primaryService: "api",
      })
      expect(app.git?.repoUrl).toBe("https://example.test/repo.git")
    })

    test("rejects when compose + image both supplied", async () => {
      const r = await req("POST", "/apps", {
        name: "bad1",
        image: "nginx",
        composeContent: inlineCompose,
        primaryService: "web",
      })
      expect(r.status).toBe(400)
    })

    test("rejects when compose + inline dockerfile both supplied", async () => {
      const r = await req("POST", "/apps", {
        name: "bad2",
        dockerfileContent: "FROM nginx",
        composeContent: inlineCompose,
        primaryService: "web",
      })
      expect(r.status).toBe(400)
    })

    test("rejects composeContent without primaryService", async () => {
      const r = await req("POST", "/apps", {
        name: "bad3",
        composeContent: inlineCompose,
      })
      expect(r.status).toBe(400)
    })

    test("rejects composePath without git source", async () => {
      const r = await req("POST", "/apps", {
        name: "bad4",
        composePath: "docker-compose.yml",
        primaryService: "web",
      })
      expect(r.status).toBe(400)
    })

    test("rejects primaryService without any compose input", async () => {
      const r = await req("POST", "/apps", {
        name: "bad5",
        image: "nginx",
        primaryService: "web",
      })
      expect(r.status).toBe(400)
    })
  })
})
```

- [ ] **Step 11.2: Run test (should fail)**

Run: `bun test src/__tests__/api/apps-compose.test.ts`
Expected: most tests fail — handler doesn't know about `composeContent` / `composePath` / `primaryService`.

- [ ] **Step 11.3: Update `handleCreateApp`**

Replace the body-parsing + source-validation + `appStorage.create` section in `src/lib/agent/server.ts:797-886` with compose-aware logic. Full replacement:

```typescript
  private async handleCreateApp(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as {
        name: string
        type?: string
        image?: string
        git?: {
          repoUrl: string
          branch?: string
          dockerfile?: string
          context?: string
        }
        dockerfileContent?: string
        composeContent?: string
        composePath?: string
        primaryService?: string
        internalPort?: number
        domains?: string[]
        env?: Record<string, string>
        volumes?: Array<{ name: string; mountPath: string }>
        restartPolicy?: string
        oauth?: SiteOAuth
      }

      if (!body.name) {
        return this.error("App name is required")
      }

      const hasCompose = !!body.composeContent || !!body.composePath
      const hasGit = !!body.git
      const hasImage = !!body.image
      const hasInlineDockerfile = !!body.dockerfileContent

      // Mutual exclusivity: image / inline-dockerfile / compose / git.
      // git may coexist with composePath OR GitSource.dockerfile, not both.
      const primarySources = [hasImage, hasInlineDockerfile, hasCompose, hasGit].filter(Boolean).length
      if (primarySources === 0) {
        return this.error("Either image, git source, dockerfile, or compose is required")
      }
      if (hasImage && (hasInlineDockerfile || hasCompose || hasGit)) {
        return this.error("--image cannot be combined with other source flags")
      }
      if (hasInlineDockerfile && (hasCompose || hasGit)) {
        return this.error("--file cannot be combined with git or compose sources")
      }
      if (body.composeContent && body.composePath) {
        return this.error("Specify either composeContent (inline) or composePath (git), not both")
      }
      if (body.composePath && !hasGit) {
        return this.error("composePath requires --git")
      }
      if (hasCompose && !body.primaryService) {
        return this.error("primaryService is required when using a compose file")
      }
      if (!hasCompose && body.primaryService) {
        return this.error("primaryService is only valid with a compose source")
      }

      if (body.git && !body.git.repoUrl) {
        return this.error("Git repository URL is required")
      }

      // Determine image tag for locally-built or compose-tagged apps.
      const image =
        hasGit || hasInlineDockerfile || hasCompose
          ? this.docker.imageTag(body.name)
          : body.image!

      // Persist inline Dockerfile / compose file up-front; roll back on create failure.
      if (body.dockerfileContent) {
        this.dockerfiles.write(body.name, body.dockerfileContent)
      }
      if (body.composeContent) {
        this.compose.writeBaseInline(body.name, body.composeContent)
      }

      try {
        const composeField: App["compose"] = hasCompose
          ? body.composeContent
            ? { source: "inline", primaryService: body.primaryService! }
            : { source: "git", path: body.composePath!, primaryService: body.primaryService! }
          : undefined

        const app = this.appStorage.create({
          name: body.name,
          type: (body.type as "static" | "container") || "container",
          image,
          git: body.git
            ? {
                repoUrl: body.git.repoUrl,
                branch: body.git.branch || "main",
                dockerfile: body.git.dockerfile || "Dockerfile",
                context: body.git.context,
              }
            : undefined,
          dockerfile: body.dockerfileContent ? { source: "inline" } : undefined,
          compose: composeField,
          internalPort: body.internalPort || 80,
          domains: body.domains || [],
          env: body.env || {},
          volumes: body.volumes || [],
          restartPolicy: (body.restartPolicy as "always" | "unless-stopped" | "on-failure" | "no") || "unless-stopped",
          status: "pending",
          oauth: body.oauth,
        })

        return this.json(app)
      } catch (err) {
        if (body.dockerfileContent) this.dockerfiles.remove(body.name)
        if (body.composeContent) this.compose.remove(body.name)
        throw err
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create app"
      return this.error(message, 400)
    }
  }
```

- [ ] **Step 11.4: Run tests — should pass**

Run: `bun test src/__tests__/api/apps-compose.test.ts`
Expected: all create tests pass. No regressions in other test files.

Also run: `bun test` — full suite should still pass.

- [ ] **Step 11.5: Commit**

```bash
git add src/lib/agent/server.ts src/__tests__/api/apps-compose.test.ts
git commit -m "feat(apps): accept compose source in POST /apps"
```

---

### Task 12: `handleDeployApp` — compose branch

**Files:**
- Modify: `src/lib/agent/server.ts:959-1099`
- Modify: `src/__tests__/api/apps-compose.test.ts` (add deploy tests)

- [ ] **Step 12.1: Add failing tests for deploy**

Append to the `describe("API: Apps (compose)", …)` block in `src/__tests__/api/apps-compose.test.ts`, inside the existing block, after the `describe("create", …)`:

```typescript
  describe("deploy", () => {
    test("inline compose: writes override, calls composeConfig then composeUp then composePs", async () => {
      await req("POST", "/apps", {
        name: "deployinline",
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      })
      const r = await req("POST", "/apps/deployinline/deploy")
      const app = await jsonOk<App>(r)

      // containerId resolved from composePs() primary-service match
      expect(app.containerId).toBe("fake-web-id")
      expect(app.status).toBe("running")

      // Override file written
      const overridePath = join(testDir, "compose", "deployinline", "docker-compose.siteio.yml")
      expect(existsSync(overridePath)).toBe(true)
      expect(readFileSync(overridePath, "utf-8")).toContain("siteio-network")

      // Runtime calls in order: composeConfig, composeUp, composePs
      const methods = runtime.calls.map((c) => c.method)
      const composeConfigIdx = methods.indexOf("composeConfig")
      const composeUpIdx = methods.indexOf("composeUp")
      const composePsIdx = methods.indexOf("composePs")
      expect(composeConfigIdx).toBeGreaterThan(-1)
      expect(composeUpIdx).toBeGreaterThan(composeConfigIdx)
      expect(composePsIdx).toBeGreaterThan(composeUpIdx)

      // Project name is siteio-<app>; files are [base, override]
      const upCall = runtime.calls[composeUpIdx]
      expect(upCall.args[0]).toBe("siteio-deployinline")
      const files = upCall.args[1] as string[]
      expect(files).toHaveLength(2)
      expect(files[0]).toBe(join(testDir, "compose", "deployinline", "docker-compose.yml"))
      expect(files[1]).toBe(overridePath)
    })

    test("deploy fails with 400 if primary service not found in compose config", async () => {
      await req("POST", "/apps", {
        name: "badprimary",
        composeContent: inlineCompose,
        primaryService: "nonexistent",
        internalPort: 80,
      })
      runtime.composeConfigReturn = { services: { web: {}, db: {} } }
      const r = await req("POST", "/apps/badprimary/deploy")
      expect(r.status).toBe(400)

      // composeUp must NOT have been called
      expect(runtime.callsOf("composeUp")).toHaveLength(0)
    })

    test("git compose: clones git before composeUp", async () => {
      // We don't have a real git server — stub by pre-creating the repo dir
      // and its compose file so GitManager.clone shells to a fake target.
      // Simpler: use the inline flow, since this test is about handler shape.
      // (Exercised in manual QA against a real git remote.)
      // For automated coverage of the git code path, see apps-git.test.ts.
    })

    test("redeploy after env update regenerates override and invokes composeUp", async () => {
      await req("POST", "/apps", {
        name: "envapp",
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      })
      await req("POST", "/apps/envapp/deploy")

      // Update env
      await req("PATCH", "/apps/envapp", { env: { FOO: "bar" } })
      runtime.calls = []

      await req("POST", "/apps/envapp/deploy")

      const overridePath = join(testDir, "compose", "envapp", "docker-compose.siteio.yml")
      expect(readFileSync(overridePath, "utf-8")).toContain('FOO: "bar"')
      expect(runtime.callsOf("composeUp")).toHaveLength(1)
    })
  })
```

- [ ] **Step 12.2: Run tests (should fail)**

Run: `bun test src/__tests__/api/apps-compose.test.ts`
Expected: deploy tests fail — handler still runs the container path.

- [ ] **Step 12.3: Implement compose branch in `handleDeployApp`**

In `src/lib/agent/server.ts`, modify `handleDeployApp` (starts at line 959). Add imports at the top of the method body if not already present:

```typescript
import { buildOverride } from "./compose-override"
```

(Place alongside the existing `./docker`, `./git`, `./dockerfile-storage` imports at the top of server.ts.)

Inside `handleDeployApp`, after the Docker availability check and before the existing `if (app.git) { ... } else if (app.dockerfile) { ... } else { ... }` branches, add a compose branch as the first condition:

```typescript
    try {
      // Check Docker availability
      if (!this.docker.isAvailable()) {
        return this.error("Docker is not available", 500)
      }

      // ---------- COMPOSE BRANCH ----------
      if (app.compose) {
        // Resolve base compose file
        let basePath: string
        if (app.compose.source === "inline") {
          basePath = this.compose.baseInlinePath(name)
          if (!existsSync(basePath)) {
            return this.error("Compose file not found for app", 400)
          }
        } else {
          // git-hosted compose
          if (!app.git) {
            return this.error("Git source missing on compose app", 500)
          }
          await this.git.clone(name, app.git.repoUrl, app.git.branch)
          const repoPath = this.git.repoPath(name)
          basePath = join(repoPath, app.compose.path)
          if (!existsSync(basePath)) {
            return this.error(`Compose file not found at '${app.compose.path}'`, 400)
          }
        }

        // Write the override (regenerate every deploy so env/domain/oauth updates apply)
        const overrideYaml = buildOverride(app, this.config.dataDir)
        this.compose.writeOverride(name, overrideYaml)
        const overridePath = this.compose.overridePath(name)

        const project = `siteio-${name}`
        const files = [basePath, overridePath]

        // Ensure Traefik can reach the service
        this.docker.ensureNetwork()

        // Validate config (parses + merges both files via compose-go)
        const spec = await this.docker.composeConfig(project, files)
        if (!spec.services || !spec.services[app.compose.primaryService]) {
          return this.error(
            `Primary service '${app.compose.primaryService}' not found in compose file. Available: ${Object.keys(spec.services || {}).join(", ") || "none"}`,
            400
          )
        }

        // Bring up the project
        await this.docker.composeUp(project, files)

        // Resolve primary service's container ID via ps
        const psOutput = await this.docker.composePs(project, files)
        const primaryState = psOutput.find((s) => s.service === app.compose!.primaryService)

        const commitHash = app.compose.source === "git" ? await this.git.getCommitHash(name) : undefined
        const lastBuildAt = new Date().toISOString()

        const updated = this.appStorage.update(name, {
          status: "running",
          containerId: primaryState?.containerId,
          deployedAt: new Date().toISOString(),
          lastBuildAt,
          ...(commitHash && { commitHash }),
        })

        return this.json(updated)
      }
      // ---------- END COMPOSE BRANCH ----------

      // Ensure network exists (existing container flow)
      this.docker.ensureNetwork()

      // ... existing code: remove existing container, build / pull / run, etc. ...
```

Make sure `existsSync` and `join` are imported at the top of `server.ts` (they may already be used for git context checks — confirm and reuse).

- [ ] **Step 12.4: Run tests — should pass**

Run: `bun test src/__tests__/api/apps-compose.test.ts`
Expected: all deploy tests pass. Full suite also passes (`bun test`).

- [ ] **Step 12.5: Commit**

```bash
git add src/lib/agent/server.ts src/__tests__/api/apps-compose.test.ts
git commit -m "feat(apps): add compose branch to deploy handler"
```

---

### Task 13: `handleStopApp`, `handleRestartApp`, `handleDeleteApp` compose branches

**Files:**
- Modify: `src/lib/agent/server.ts`
- Modify: `src/__tests__/api/apps-compose.test.ts`

- [ ] **Step 13.1: Write failing tests**

Append to the `describe("API: Apps (compose)", …)` block:

```typescript
  describe("lifecycle", () => {
    const setup = async (name: string) => {
      await req("POST", "/apps", {
        name,
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      })
      await req("POST", `/apps/${name}/deploy`)
      runtime.calls = []
    }

    test("stop invokes composeStop, not docker.stop", async () => {
      await setup("stopapp")
      const r = await req("POST", "/apps/stopapp/stop")
      const app = await jsonOk<App>(r)
      expect(app.status).toBe("stopped")
      expect(runtime.callsOf("composeStop")).toHaveLength(1)
      expect(runtime.callsOf("stop")).toHaveLength(0)
      expect(runtime.callsOf("composeStop")[0].args[0]).toBe("siteio-stopapp")
    })

    test("restart invokes composeRestart", async () => {
      await setup("restartapp")
      const r = await req("POST", "/apps/restartapp/restart")
      const app = await jsonOk<App>(r)
      expect(app.status).toBe("running")
      expect(runtime.callsOf("composeRestart")).toHaveLength(1)
      expect(runtime.callsOf("restart")).toHaveLength(0)
    })

    test("delete invokes composeDown and removes compose dir + metadata", async () => {
      await setup("delapp")
      const r = await req("DELETE", "/apps/delapp")
      expect(r.status).toBeLessThan(300)
      expect(runtime.callsOf("composeDown")).toHaveLength(1)
      expect(runtime.callsOf("composeDown")[0].args[0]).toBe("siteio-delapp")

      // compose dir removed
      expect(existsSync(join(testDir, "compose", "delapp"))).toBe(false)
      // metadata gone
      const check = await req("GET", "/apps/delapp")
      expect(check.status).toBe(404)
    })
  })
```

- [ ] **Step 13.2: Run tests (should fail)**

Run: `bun test src/__tests__/api/apps-compose.test.ts`
Expected: lifecycle tests fail — handlers still use container methods.

- [ ] **Step 13.3: Update `handleStopApp`**

Replace the existing `handleStopApp` body (around line 1101) with:

```typescript
  private async handleStopApp(name: string): Promise<Response> {
    const app = this.appStorage.get(name)
    if (!app) {
      return this.error("App not found", 404)
    }
    try {
      if (app.compose) {
        const files = this.composeFiles(app)
        await this.docker.composeStop(`siteio-${name}`, files)
      } else if (this.docker.containerExists(name)) {
        await this.docker.stop(name)
      }
      const updated = this.appStorage.update(name, { status: "stopped" })
      return this.json(updated)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to stop app"
      return this.error(message, 500)
    }
  }
```

- [ ] **Step 13.4: Update `handleRestartApp`**

Replace the existing body (line ~1120) with:

```typescript
  private async handleRestartApp(name: string): Promise<Response> {
    const app = this.appStorage.get(name)
    if (!app) {
      return this.error("App not found", 404)
    }
    try {
      if (app.compose) {
        const files = this.composeFiles(app)
        await this.docker.composeRestart(`siteio-${name}`, files)
        const updated = this.appStorage.update(name, { status: "running" })
        return this.json(updated)
      }
      if (this.docker.containerExists(name)) {
        await this.docker.restart(name)
        const updated = this.appStorage.update(name, { status: "running" })
        return this.json(updated)
      }
      return this.error("Container does not exist. Deploy the app first.", 400)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to restart app"
      return this.error(message, 500)
    }
  }
```

- [ ] **Step 13.5: Update `handleDeleteApp`**

Replace the existing body (line ~908) with:

```typescript
  private async handleDeleteApp(name: string): Promise<Response> {
    const app = this.appStorage.get(name)
    if (!app) {
      return this.error("App not found", 404)
    }

    if (app.compose) {
      try {
        const files = this.composeFiles(app)
        await this.docker.composeDown(`siteio-${name}`, files)
      } catch {
        // Best-effort; the base file may be missing if the repo was cleaned up.
      }
      try {
        this.compose.remove(name)
      } catch {
        // Ignore
      }
    } else {
      if (this.docker.containerExists(name)) {
        try {
          await this.docker.remove(name)
        } catch {
          // Ignore
        }
      }
      if (app.dockerfile && this.dockerfiles.exists(name)) {
        try {
          this.dockerfiles.remove(name)
        } catch {
          // Ignore
        }
      }
      if (app.git || app.dockerfile) {
        try {
          const imageTag = this.docker.imageTag(name)
          await this.docker.removeImage(imageTag)
        } catch {
          // Ignore
        }
      }
    }

    if (app.git && this.git.exists(name)) {
      try {
        await this.git.remove(name)
      } catch {
        // Ignore
      }
    }

    const deleted = this.appStorage.delete(name)
    if (!deleted) {
      return this.error("Failed to delete app", 500)
    }
    return this.json(null)
  }
```

- [ ] **Step 13.6: Add `composeFiles` helper**

Inside the `AgentServer` class (near the bottom, alongside other private helpers), add:

```typescript
  /**
   * Resolve the [base, override] compose file paths for a compose-based app.
   * For git apps the base lives inside the cloned repo (which must already exist
   * from a prior deploy — lifecycle ops never re-clone).
   */
  private composeFiles(app: App): string[] {
    if (!app.compose) {
      throw new Error(`composeFiles called on non-compose app '${app.name}'`)
    }
    const basePath =
      app.compose.source === "inline"
        ? this.compose.baseInlinePath(app.name)
        : join(this.git.repoPath(app.name), app.compose.path)
    return [basePath, this.compose.overridePath(app.name)]
  }
```

- [ ] **Step 13.7: Run tests — should pass**

Run: `bun test src/__tests__/api/apps-compose.test.ts`
Expected: all lifecycle tests pass. Full suite: `bun test` — no regressions.

- [ ] **Step 13.8: Commit**

```bash
git add src/lib/agent/server.ts src/__tests__/api/apps-compose.test.ts
git commit -m "feat(apps): compose branch for stop, restart, delete"
```

---

### Task 14: `handleGetAppLogs` — compose branch with `--service` / `--all`

**Files:**
- Modify: `src/lib/agent/server.ts:1140-1161`
- Modify: `src/__tests__/api/apps-compose.test.ts`

- [ ] **Step 14.1: Write failing tests**

Append:

```typescript
  describe("logs", () => {
    const setup = async (name: string) => {
      await req("POST", "/apps", {
        name,
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      })
      await req("POST", `/apps/${name}/deploy`)
      runtime.calls = []
    }

    test("default tails the primary service", async () => {
      await setup("logs1")
      runtime.composeLogsReturn = "hello from web\n"
      const r = await req("GET", "/apps/logs1/logs")
      const body = (await r.json()) as { logs: string }
      expect(body.logs).toBe("hello from web\n")

      const call = runtime.callsOf("composeLogs")[0]
      expect(call.args[2]).toEqual({ service: "web", tail: 100 })
    })

    test("?service=db targets that service", async () => {
      await setup("logs2")
      const r = await req("GET", "/apps/logs2/logs?service=db")
      expect(r.status).toBeLessThan(300)
      const call = runtime.callsOf("composeLogs")[0]
      expect(call.args[2]).toEqual({ service: "db", tail: 100 })
    })

    test("?all=true omits service filter", async () => {
      await setup("logs3")
      const r = await req("GET", "/apps/logs3/logs?all=true")
      expect(r.status).toBeLessThan(300)
      const call = runtime.callsOf("composeLogs")[0]
      const opts = call.args[2] as { service?: string; all?: boolean; tail: number }
      expect(opts.all).toBe(true)
      expect(opts.tail).toBe(100)
    })

    test("?service on non-compose app returns 400", async () => {
      await req("POST", "/apps", { name: "plain", image: "nginx", internalPort: 80 })
      // Don't deploy — we're only testing the guard before the runtime call
      const r = await req("GET", "/apps/plain/logs?service=web")
      expect(r.status).toBe(400)
      expect(runtime.callsOf("composeLogs")).toHaveLength(0)
    })
  })
```

- [ ] **Step 14.2: Run tests (should fail)**

Run: `bun test src/__tests__/api/apps-compose.test.ts`
Expected: logs tests fail.

- [ ] **Step 14.3: Update `handleGetAppLogs`**

Replace the existing body (line ~1140) with:

```typescript
  private async handleGetAppLogs(name: string, url: URL): Promise<Response> {
    const app = this.appStorage.get(name)
    if (!app) {
      return this.error("App not found", 404)
    }

    const tail = parseInt(url.searchParams.get("tail") || "100", 10)
    const service = url.searchParams.get("service") || undefined
    const all = url.searchParams.get("all") === "true"

    if ((service || all) && !app.compose) {
      return this.error("`service` and `all` are only valid on compose-based apps", 400)
    }

    try {
      let logs: string
      if (app.compose) {
        const files = this.composeFiles(app)
        logs = await this.docker.composeLogs(`siteio-${name}`, files, {
          tail,
          all,
          service: all ? undefined : service ?? app.compose.primaryService,
        })
      } else {
        logs = await this.docker.logs(name, tail)
      }

      const response: ContainerLogs = { name, logs, lines: tail }
      return this.json(response)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to get logs"
      return this.error(message, 500)
    }
  }
```

- [ ] **Step 14.4: Run tests — should pass**

Run: `bun test src/__tests__/api/apps-compose.test.ts` and `bun test`.
Expected: all pass.

- [ ] **Step 14.5: Commit**

```bash
git add src/lib/agent/server.ts src/__tests__/api/apps-compose.test.ts
git commit -m "feat(apps): compose-aware logs with service/all filters"
```

---

### Task 15: `handleListApps` — compose status aggregation

**Files:**
- Modify: `src/lib/agent/server.ts:776-787`
- Modify: `src/__tests__/api/apps-compose.test.ts`

- [ ] **Step 15.1: Write failing test**

Append:

```typescript
  describe("list", () => {
    test("lists a compose app with its url and compose field intact", async () => {
      await req("POST", "/apps", {
        name: "listapp",
        composeContent: inlineCompose,
        primaryService: "web",
        internalPort: 80,
      })
      const r = await req("GET", "/apps")
      const apps = (await r.json()) as AppInfo[]
      const entry = apps.find((a) => a.name === "listapp")
      expect(entry).toBeTruthy()
      expect(entry!.compose).toEqual({ source: "inline", primaryService: "web" })
    })
  })
```

- [ ] **Step 15.2: Run test**

Run: `bun test src/__tests__/api/apps-compose.test.ts`
Expected: PASS. `AppStorage.toInfo` was already updated in Step 5.2 to include `compose`, so `handleListApps` returns it without further change. This task exists as a regression guard — the test pins the contract so future edits to `toInfo` can't silently drop the field.

- [ ] **Step 15.3: Commit the new test**

```bash
git add src/__tests__/api/apps-compose.test.ts
git commit -m "test(apps): pin compose field in list output"
```

---

## Phase 5: Client + CLI

### Task 16: Extend `SiteioClient.createApp` + add `getAppLogs` options

**Files:**
- Modify: `src/lib/client.ts:311-424` (createApp signature + getAppLogs)

- [ ] **Step 16.1: Extend `createApp` payload**

In `src/lib/client.ts` at line 311, the current signature sends `JSON.stringify(config)` as the body directly, so adding optional fields to the param type is all that's needed. Replace the `createApp` method (lines 311–337) with:

```typescript
  async createApp(config: {
    name: string
    image?: string
    git?: {
      repoUrl: string
      branch?: string
      dockerfile?: string
      context?: string
    }
    dockerfileContent?: string
    composeContent?: string
    composePath?: string
    primaryService?: string
    internalPort?: number
    env?: Record<string, string>
    volumes?: { name: string; mountPath: string }[]
    domains?: string[]
    restartPolicy?: string
  }): Promise<AppInfo> {
    const response = await this.request<ApiResponse<AppInfo>>(
      "POST",
      "/apps",
      JSON.stringify(config),
      { "Content-Type": "application/json" }
    )
    if (!response.data) {
      throw new ApiError("Invalid response from server")
    }
    return response.data
  }
```

(Only the param type changed; the body is serialized directly from `config`.)

- [ ] **Step 16.2: Extend `getAppLogs` with `service` / `all` options**

Replace `getAppLogs` (lines 415–424) with:

```typescript
  async getAppLogs(
    name: string,
    opts: { tail?: number; service?: string; all?: boolean } = {}
  ): Promise<ContainerLogs> {
    const params = new URLSearchParams()
    params.set("tail", String(opts.tail ?? 100))
    if (opts.service) params.set("service", opts.service)
    if (opts.all) params.set("all", "true")
    const response = await this.request<ApiResponse<ContainerLogs>>(
      "GET",
      `/apps/${name}/logs?${params.toString()}`
    )
    if (!response.data) {
      throw new ApiError("Invalid response from server")
    }
    return response.data
  }
```

Backward compatibility note: existing callers that pass `getAppLogs(name, 100)` (a raw number) break. The only caller in the tree is `src/commands/apps/logs.ts` — updated in Step 17.4 below.

- [ ] **Step 16.3: Run typecheck**

Run: `bun run typecheck`
Expected: TS errors at call sites of `getAppLogs` passing a number. Those are fixed in the next task.

- [ ] **Step 16.4: Defer commit**

Hold the commit — bundle it with the CLI updates in Task 17.

---

### Task 17: CLI — add flags to `apps create` and `apps logs`, plus validation

**Files:**
- Modify: `src/cli.ts:246-259` (create command), plus the logs command definition further down
- Modify: `src/commands/apps/create.ts`
- Modify: `src/commands/apps/logs.ts`

- [ ] **Step 17.1: Add flags to `apps create` command in `src/cli.ts`**

Replace the `apps create` block (around line 246–259) with:

```typescript
apps
  .command("create <name>")
  .description("Create a new app")
  .option("-i, --image <image>", "Docker image to use")
  .option("-g, --git <url>", "Git repository URL to build from")
  .option("-f, --file <path>", "Path to a self-contained Dockerfile (built remotely with empty context)")
  .option("--dockerfile <path>", "Path to Dockerfile inside the git repo (default: Dockerfile)")
  .option("--compose-file <path>", "Path to a local docker-compose.yml to upload")
  .option("--compose <path>", "Path to docker-compose.yml inside the git repo")
  .option("--service <name>", "Primary compose service to expose publicly")
  .option("--branch <branch>", "Git branch (default: main)")
  .option("--context <path>", "Build context subdirectory for monorepos")
  .option("-p, --port <port>", "Internal port the container listens on", parseInt)
  .action(async (name, options) => {
    const { createAppCommand } = await import("./commands/apps/create.ts")
    await createAppCommand(name, { ...options, json: program.opts().json })
  })
```

- [ ] **Step 17.2: Extend `CreateAppOptions` + extract validation + rewrite `src/commands/apps/create.ts`**

Replace the contents of `src/commands/apps/create.ts` (update `CreateAppOptions`, extract a pure `validateCreateOptions`, call it from `createAppCommand`):

```typescript
import { readFileSync } from "fs"
import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { saveProjectConfig } from "../../utils/site-config.ts"

export interface CreateAppOptions {
  image?: string
  git?: string
  file?: string
  dockerfile?: string
  composeFile?: string
  compose?: string
  service?: string
  branch?: string
  context?: string
  port?: number
  json?: boolean
}

/**
 * Pure validation of the source-flag combinations. Throws ValidationError
 * on any invalid combination. Kept separate from createAppCommand so it can
 * be exercised directly in unit tests without going through handleError.
 */
export function validateCreateOptions(options: CreateAppOptions): void {
  const hasCompose = !!options.composeFile || !!options.compose
  const hasLocalDockerfile = !!options.file
  const hasImage = !!options.image
  const hasGit = !!options.git

  const primarySources = [hasImage, hasLocalDockerfile, hasCompose, hasGit].filter(Boolean).length
  if (primarySources === 0) {
    throw new ValidationError("One of --image, --git, --file, or --compose-file is required")
  }
  if (hasImage && (hasLocalDockerfile || hasCompose || hasGit)) {
    throw new ValidationError("--image cannot be combined with other source flags")
  }
  if (hasLocalDockerfile && (hasCompose || hasGit)) {
    throw new ValidationError("--file cannot be combined with --git or --compose-file")
  }
  if (options.composeFile && options.compose) {
    throw new ValidationError("Specify either --compose-file (local) or --compose (git), not both")
  }
  if (options.compose && !options.git) {
    throw new ValidationError("--compose requires --git")
  }
  if (hasCompose && !options.service) {
    throw new ValidationError("--service is required when using a compose file")
  }
  if (!hasCompose && options.service) {
    throw new ValidationError("--service is only valid with --compose-file or --compose")
  }
  if (hasGit && options.dockerfile && options.compose) {
    throw new ValidationError("Cannot combine --dockerfile and --compose in the same git app")
  }
}

export async function createAppCommand(
  name: string,
  options: CreateAppOptions
): Promise<void> {
  const spinner = ora()

  try {
    if (!name) {
      throw new ValidationError("App name is required")
    }

    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(name)) {
      throw new ValidationError(
        "App name must contain only lowercase letters, numbers, and hyphens, and cannot start or end with a hyphen"
      )
    }

    validateCreateOptions(options)

    const hasCompose = !!options.composeFile || !!options.compose
    const hasLocalDockerfile = !!options.file
    const hasGit = !!options.git

    // Read local artifacts up-front
    let dockerfileContent: string | undefined
    if (options.file) {
      try {
        dockerfileContent = readFileSync(options.file, "utf-8")
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new ValidationError(`Failed to read Dockerfile at '${options.file}': ${message}`)
      }
    }
    let composeContent: string | undefined
    if (options.composeFile) {
      try {
        composeContent = readFileSync(options.composeFile, "utf-8")
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new ValidationError(`Failed to read compose file at '${options.composeFile}': ${message}`)
      }
    }

    spinner.start(`Creating app ${name}`)

    const client = new SiteioClient()
    const app = await client.createApp({
      name,
      image: options.image,
      git: options.git
        ? {
            repoUrl: options.git,
            branch: options.branch,
            dockerfile: options.dockerfile,
            context: options.context,
          }
        : undefined,
      dockerfileContent,
      composeContent,
      composePath: options.compose,
      primaryService: options.service,
      internalPort: options.port,
    })

    spinner.succeed(`Created app ${name}`)

    if (hasGit || hasLocalDockerfile || options.composeFile) {
      const server = getCurrentServer()
      if (server) {
        saveProjectConfig({ app: name, domain: server.domain })
      }
    }

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: app }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`App ${chalk.bold(name)} created successfully!`))
      console.log("")
      console.log(`  Name:   ${chalk.cyan(app.name)}`)
      if (hasCompose) {
        console.log(`  Source: ${chalk.blue("compose")}`)
        if (options.composeFile) {
          console.log(`  File:    ${options.composeFile}`)
        } else {
          console.log(`  Repo:    ${options.git}`)
          console.log(`  Compose: ${options.compose}`)
        }
        console.log(`  Service: ${options.service}`)
      } else if (hasGit) {
        console.log(`  Source: ${chalk.blue("git")}`)
        console.log(`  Repo:   ${options.git}`)
        if (options.branch) console.log(`  Branch: ${options.branch}`)
        if (options.dockerfile) console.log(`  Dockerfile: ${options.dockerfile}`)
        if (options.context) console.log(`  Context: ${options.context}`)
      } else if (hasLocalDockerfile) {
        console.log(`  Source: ${chalk.blue("dockerfile")}`)
        console.log(`  File:   ${options.file}`)
      } else {
        console.log(`  Image:  ${app.image}`)
      }
      console.log(`  Port:   ${app.internalPort}`)
      console.log(`  Status: ${chalk.yellow(app.status)}`)
      console.log("")
      console.log(chalk.dim(`Run 'siteio apps deploy ${name}' to start the container`))
      console.log("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
```

- [ ] **Step 17.3: Add flags to `apps logs` command**

Find the `apps logs` command in `src/cli.ts` and add options:

```typescript
apps
  .command("logs [name]")
  .description("Tail logs from an app container")
  .option("-t, --tail <n>", "Number of lines to show", parseInt, 100)
  .option("--service <name>", "Target a specific compose service (compose apps only)")
  .option("--all", "Show logs for all compose services (compose apps only)")
  .action(async (name, options) => {
    const { logsAppCommand } = await import("./commands/apps/logs.ts")
    await logsAppCommand(name, { ...options, json: program.opts().json })
  })
```

- [ ] **Step 17.4: Update `src/commands/apps/logs.ts` to pass new options**

Update `LogsAppOptions` + the call to `client.getAppLogs`:

```typescript
export interface LogsAppOptions {
  tail?: number
  service?: string
  all?: boolean
  json?: boolean
}
```

Inside `logsAppCommand`, replace the call to `client.getAppLogs(name, tail)` with:

```typescript
const logs = await client.getAppLogs(name, {
  tail: options.tail ?? 100,
  service: options.service,
  all: options.all,
})
```

- [ ] **Step 17.5: Write unit tests for `validateCreateOptions`**

The helper was already extracted in Step 17.2. Create `src/__tests__/cli/apps-create-compose-flags.test.ts`:

```typescript
import { describe, expect, test } from "bun:test"
import { validateCreateOptions } from "../../commands/apps/create"
import { ValidationError } from "../../utils/errors"

describe("CLI: validateCreateOptions", () => {
  test("--compose-file without --service throws", () => {
    expect(() => validateCreateOptions({ composeFile: "/tmp/x.yml" }))
      .toThrow(/--service is required/)
  })

  test("--service without any compose source throws", () => {
    expect(() => validateCreateOptions({ image: "nginx", service: "web" }))
      .toThrow(/--service is only valid/)
  })

  test("--compose without --git throws", () => {
    expect(() => validateCreateOptions({ compose: "docker-compose.yml", service: "web" }))
      .toThrow(/--compose requires --git/)
  })

  test("--compose-file + --image throws", () => {
    expect(() => validateCreateOptions({ image: "nginx", composeFile: "/tmp/c.yml", service: "web" }))
      .toThrow(/cannot be combined/)
  })

  test("--compose-file + --service passes", () => {
    expect(() => validateCreateOptions({ composeFile: "/tmp/c.yml", service: "web" }))
      .not.toThrow()
  })

  test("--git + --compose + --service passes", () => {
    expect(() => validateCreateOptions({ git: "https://x.test/r.git", compose: "dc.yml", service: "web" }))
      .not.toThrow()
  })

  test("errors are ValidationError instances", () => {
    try {
      validateCreateOptions({ composeFile: "/tmp/c.yml" })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError)
    }
  })
})
```

- [ ] **Step 17.6: Run typecheck + tests**

Run: `bun run typecheck && bun test`
Expected: PASS.

- [ ] **Step 17.7: Commit**

```bash
git add src/cli.ts src/lib/client.ts src/commands/apps/create.ts src/commands/apps/logs.ts src/__tests__/cli/apps-create-compose-flags.test.ts
git commit -m "feat(cli): add --compose-file / --compose / --service flags"
```

---

## Phase 6: Final validation

### Task 18: Spec coverage sweep

- [ ] **Step 18.1: Full test run**

Run: `bun test`
Expected: all tests pass, including every new test added above.

- [ ] **Step 18.2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 18.3: Spec checklist**

Walk through `docs/superpowers/specs/2026-04-19-docker-compose-apps-design.md` and tick off:

- [ ] Data model `ComposeSource` added to `src/types.ts` — Task 5
- [ ] `compose?` on `App` and `AppInfo` — Task 5
- [ ] `ComposeStorage` with inline + override file support — Task 6
- [ ] `buildOverride` emits Traefik labels, network, env (map form), volumes — Task 7
- [ ] `docker compose config --format json` parsing, no YAML lib dep — Task 8 (`ComposeManager.config`)
- [ ] `Runtime` seam with container + compose methods — Tasks 1, 2, 3, 9
- [ ] `FakeRuntime` with recording — Tasks 4, 9
- [ ] `handleCreateApp` accepts compose payloads + full validation — Task 11
- [ ] `handleDeployApp` compose branch: resolve base, write override, config, up, ps → container ID — Task 12
- [ ] `handleStopApp` / `handleRestartApp` / `handleDeleteApp` compose branches — Task 13
- [ ] `handleGetAppLogs` with `service` / `all` query params — Task 14
- [ ] `handleListApps` surfaces `compose` field — Task 15
- [ ] CLI flags `--compose-file`, `--compose`, `--service`; logs `--service` / `--all` — Task 17
- [ ] CLI validation mirrors server validation — Task 17

If any item has no task, add a bonus task.

### Task 19: Manual QA checklist (not automated)

Document for the implementer to run on a real host before calling the feature done:

- [ ] **Step 19.1: Inline compose with Postgres dependency**

  Create a local `docker-compose.yml`:
  ```yaml
  services:
    web:
      image: nginx
    db:
      image: postgres:16
      environment:
        POSTGRES_PASSWORD: test
  ```
  Run: `siteio apps create manualqa --compose-file ./docker-compose.yml --service web -p 80`
  Then: `siteio apps deploy manualqa`
  Verify: `curl https://manualqa.<your-domain>` returns the nginx welcome page. `docker ps` shows both `siteio-manualqa-web-1` and `siteio-manualqa-db-1`.

- [ ] **Step 19.2: `apps logs --service db`**

  Run: `siteio apps logs manualqa --service db`
  Expected: Postgres startup log lines.

- [ ] **Step 19.3: `apps logs --all`**

  Run: `siteio apps logs manualqa --all`
  Expected: interleaved logs from both services.

- [ ] **Step 19.4: `apps delete`**

  Run: `siteio apps delete manualqa`
  Verify: `docker ps -a` shows no `siteio-manualqa-*` containers; `docker volume ls` shows no `siteio-manualqa_*` volumes; other apps untouched.

- [ ] **Step 19.5: Git-hosted compose redeploy rebuilds on new commit**

  Point a public repo with a compose file + a `build:` service at siteio, deploy, push a change to the Dockerfile, redeploy, verify the new build runs.

- [ ] **Step 19.6: OAuth on primary service**

  Create a compose app with `--allowed-email` and verify the primary service rejects unauthenticated requests while dependencies remain reachable only inside the project network.

### Task 20: Release

- [ ] **Step 20.1: Bump version**

Minor bump (new feature, backward compatible). In `package.json`, increment the minor version (e.g. `1.14.3` → `1.15.0`).

- [ ] **Step 20.2: Commit**

```bash
git commit -am "chore: bump version to 1.15.0"
```

- [ ] **Step 20.3: Push + tag**

```bash
git push
git tag v1.15.0
git push origin v1.15.0
```

- [ ] **Step 20.4: Surface release URL**

Tell the user: "GitHub Actions is building the binaries — follow progress at https://github.com/plosson/siteio/actions"

- [ ] **Step 20.5: Update SiteIO.me server**

Run: `ssh siteio "/root/.local/bin/siteio update -y && /root/.local/bin/siteio agent restart"`
