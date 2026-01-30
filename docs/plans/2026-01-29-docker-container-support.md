# Docker Container Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend siteio to deploy Docker containers alongside static sites, with unified container management for both types.

**Architecture:** Add a DockerManager for container lifecycle, AppStorage for unified app metadata, and extend the agent server with container-specific API endpoints. Static sites will eventually run as nginx containers, but this plan focuses on container deployment first to validate the architecture before migrating static sites.

**Tech Stack:** Bun runtime, TypeScript, Docker CLI (via spawnSync), Traefik for routing, JSON file-based storage.

---

## Phase 1: Foundation - Docker Container Support

### Task 1: Add Container Types

**Files:**
- Modify: `src/types.ts`

**Step 1: Add container-related types to types.ts**

Add these types after the existing `SiteOAuth` interface:

```typescript
// Container restart policies
export type RestartPolicy = "always" | "unless-stopped" | "on-failure" | "no"

// Container status
export type ContainerStatus = "pending" | "running" | "stopped" | "failed"

// App types (static sites vs containers)
export type AppType = "static" | "container"

// Volume mount configuration
export interface VolumeMount {
  name: string
  mountPath: string
}

// Git source configuration for building from repo
export interface GitSource {
  repoUrl: string
  branch: string
  dockerfile: string
  credentialId?: string
}

// Core App interface - unified model for sites and containers
export interface App {
  name: string
  type: AppType

  // Source
  image: string
  git?: GitSource

  // Runtime
  env: Record<string, string>
  volumes: VolumeMount[]
  internalPort: number
  restartPolicy: RestartPolicy

  // Routing
  domains: string[]

  // OAuth (same as current sites)
  oauth?: SiteOAuth

  // State
  containerId?: string
  status: ContainerStatus
  deployedAt?: string
  createdAt: string
  updatedAt: string
}

// App info returned to clients (subset of App)
export interface AppInfo {
  name: string
  type: AppType
  image: string
  status: ContainerStatus
  domains: string[]
  internalPort: number
  deployedAt?: string
  createdAt: string
}

// Container logs response
export interface ContainerLogs {
  name: string
  logs: string
  lines: number
}

// Container inspection result
export interface ContainerInspect {
  id: string
  name: string
  state: {
    running: boolean
    status: string
    startedAt?: string
    exitCode?: number
  }
  image: string
  ports: Record<string, string>
}
```

**Step 2: Run typecheck to verify types are valid**

Run: `bun run typecheck`
Expected: PASS (no type errors)

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "$(cat <<'EOF'
feat: add container-related TypeScript types

Add App, AppInfo, ContainerStatus, RestartPolicy, VolumeMount,
GitSource, ContainerLogs, and ContainerInspect interfaces to
support Docker container deployment.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Create AppStorage Class

**Files:**
- Create: `src/lib/agent/app-storage.ts`
- Test: `src/__tests__/app-storage.test.ts`

**Step 1: Write the failing test**

Create `src/__tests__/app-storage.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AppStorage } from "../lib/agent/app-storage"
import type { App, AppType, ContainerStatus, RestartPolicy } from "../types"

describe("AppStorage", () => {
  let testDir: string
  let storage: AppStorage

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "siteio-test-"))
    storage = new AppStorage(testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  const createTestApp = (name: string, overrides: Partial<App> = {}): Omit<App, "createdAt" | "updatedAt"> => ({
    name,
    type: "container" as AppType,
    image: "nginx:alpine",
    env: {},
    volumes: [],
    internalPort: 80,
    restartPolicy: "unless-stopped" as RestartPolicy,
    domains: [`${name}.example.com`],
    status: "pending" as ContainerStatus,
    ...overrides,
  })

  test("should create an app", () => {
    const appData = createTestApp("myapp")
    const app = storage.create(appData)

    expect(app.name).toBe("myapp")
    expect(app.type).toBe("container")
    expect(app.status).toBe("pending")
    expect(app.createdAt).toBeDefined()
    expect(app.updatedAt).toBeDefined()
  })

  test("should get an app by name", () => {
    storage.create(createTestApp("myapp"))
    const app = storage.get("myapp")

    expect(app).not.toBeNull()
    expect(app!.name).toBe("myapp")
  })

  test("should return null for non-existent app", () => {
    const app = storage.get("nonexistent")
    expect(app).toBeNull()
  })

  test("should list all apps", () => {
    storage.create(createTestApp("app1"))
    storage.create(createTestApp("app2"))
    storage.create(createTestApp("app3"))

    const apps = storage.list()
    expect(apps).toHaveLength(3)
    expect(apps.map((a) => a.name).sort()).toEqual(["app1", "app2", "app3"])
  })

  test("should update an app", () => {
    storage.create(createTestApp("myapp"))
    const updated = storage.update("myapp", {
      status: "running",
      containerId: "abc123",
    })

    expect(updated).not.toBeNull()
    expect(updated!.status).toBe("running")
    expect(updated!.containerId).toBe("abc123")
  })

  test("should return null when updating non-existent app", () => {
    const result = storage.update("nonexistent", { status: "running" })
    expect(result).toBeNull()
  })

  test("should delete an app", () => {
    storage.create(createTestApp("myapp"))
    const deleted = storage.delete("myapp")

    expect(deleted).toBe(true)
    expect(storage.get("myapp")).toBeNull()
  })

  test("should return false when deleting non-existent app", () => {
    const deleted = storage.delete("nonexistent")
    expect(deleted).toBe(false)
  })

  test("should check if app exists", () => {
    storage.create(createTestApp("myapp"))

    expect(storage.exists("myapp")).toBe(true)
    expect(storage.exists("nonexistent")).toBe(false)
  })

  test("should persist apps across instances", () => {
    storage.create(createTestApp("myapp"))

    // Create new storage instance pointing to same directory
    const storage2 = new AppStorage(testDir)
    const app = storage2.get("myapp")

    expect(app).not.toBeNull()
    expect(app!.name).toBe("myapp")
  })

  test("should reject invalid app names", () => {
    expect(() => storage.create(createTestApp("My App"))).toThrow()
    expect(() => storage.create(createTestApp("my_app"))).toThrow()
    expect(() => storage.create(createTestApp("api"))).toThrow()
    expect(() => storage.create(createTestApp(""))).toThrow()
  })

  test("should reject duplicate app names", () => {
    storage.create(createTestApp("myapp"))
    expect(() => storage.create(createTestApp("myapp"))).toThrow()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/app-storage.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

Create `src/lib/agent/app-storage.ts`:

```typescript
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import type { App, AppInfo } from "../../types"
import { ValidationError } from "../../utils/errors"

export class AppStorage {
  private appsDir: string

  constructor(dataDir: string) {
    this.appsDir = join(dataDir, "apps")
    this.ensureDirectories()
  }

  private ensureDirectories(): void {
    if (!existsSync(this.appsDir)) {
      mkdirSync(this.appsDir, { recursive: true })
    }
  }

  private validateName(name: string): void {
    if (!name) {
      throw new ValidationError("App name cannot be empty")
    }
    if (!/^[a-z0-9-]+$/.test(name)) {
      throw new ValidationError("App name must contain only lowercase letters, numbers, and hyphens")
    }
    if (name === "api") {
      throw new ValidationError("'api' is a reserved name")
    }
  }

  private getAppPath(name: string): string {
    return join(this.appsDir, `${name}.json`)
  }

  create(appData: Omit<App, "createdAt" | "updatedAt">): App {
    this.validateName(appData.name)

    if (this.exists(appData.name)) {
      throw new ValidationError(`App '${appData.name}' already exists`)
    }

    const now = new Date().toISOString()
    const app: App = {
      ...appData,
      createdAt: now,
      updatedAt: now,
    }

    writeFileSync(this.getAppPath(app.name), JSON.stringify(app, null, 2))
    return app
  }

  get(name: string): App | null {
    const path = this.getAppPath(name)
    if (!existsSync(path)) {
      return null
    }
    return JSON.parse(readFileSync(path, "utf-8"))
  }

  update(name: string, updates: Partial<Omit<App, "name" | "createdAt">>): App | null {
    const app = this.get(name)
    if (!app) {
      return null
    }

    const updated: App = {
      ...app,
      ...updates,
      name: app.name, // Prevent name changes
      createdAt: app.createdAt, // Preserve creation date
      updatedAt: new Date().toISOString(),
    }

    writeFileSync(this.getAppPath(name), JSON.stringify(updated, null, 2))
    return updated
  }

  delete(name: string): boolean {
    const path = this.getAppPath(name)
    if (!existsSync(path)) {
      return false
    }
    rmSync(path)
    return true
  }

  exists(name: string): boolean {
    return existsSync(this.getAppPath(name))
  }

  list(): App[] {
    if (!existsSync(this.appsDir)) {
      return []
    }

    const files = readdirSync(this.appsDir).filter((f) => f.endsWith(".json"))
    return files.map((f) => {
      const content = readFileSync(join(this.appsDir, f), "utf-8")
      return JSON.parse(content) as App
    })
  }

  toInfo(app: App): AppInfo {
    return {
      name: app.name,
      type: app.type,
      image: app.image,
      status: app.status,
      domains: app.domains,
      internalPort: app.internalPort,
      deployedAt: app.deployedAt,
      createdAt: app.createdAt,
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/app-storage.test.ts`
Expected: PASS

**Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/agent/app-storage.ts src/__tests__/app-storage.test.ts
git commit -m "$(cat <<'EOF'
feat: add AppStorage class for container metadata

AppStorage provides CRUD operations for App metadata with JSON
file persistence. Includes name validation, duplicate checking,
and conversion to AppInfo for API responses.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Create DockerManager Class

**Files:**
- Create: `src/lib/agent/docker.ts`
- Test: `src/__tests__/docker.test.ts`

**Step 1: Write the failing test**

Create `src/__tests__/docker.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { DockerManager } from "../lib/agent/docker"

describe("DockerManager", () => {
  let testDir: string
  let docker: DockerManager

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "siteio-docker-test-"))
    docker = new DockerManager(testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  describe("isAvailable", () => {
    test("should detect if Docker is available", () => {
      // This test depends on the environment - Docker may or may not be installed
      const result = docker.isAvailable()
      expect(typeof result).toBe("boolean")
    })
  })

  describe("containerName", () => {
    test("should generate correct container name", () => {
      const name = docker.containerName("myapp")
      expect(name).toBe("siteio-myapp")
    })
  })

  describe("parsePortMapping", () => {
    test("should parse simple port", () => {
      const result = docker.parsePortMapping("3000")
      expect(result).toEqual({ containerPort: 3000, hostPort: undefined })
    })

    test("should parse host:container mapping", () => {
      const result = docker.parsePortMapping("8080:3000")
      expect(result).toEqual({ containerPort: 3000, hostPort: 8080 })
    })
  })

  describe("buildRunArgs", () => {
    test("should build basic run arguments", () => {
      const args = docker.buildRunArgs({
        name: "myapp",
        image: "nginx:alpine",
        internalPort: 80,
        env: {},
        volumes: [],
        restartPolicy: "unless-stopped",
        network: "siteio-network",
        labels: {},
      })

      expect(args).toContain("--name")
      expect(args).toContain("siteio-myapp")
      expect(args).toContain("--network")
      expect(args).toContain("siteio-network")
      expect(args).toContain("--restart")
      expect(args).toContain("unless-stopped")
      expect(args).toContain("-d")
      expect(args[args.length - 1]).toBe("nginx:alpine")
    })

    test("should include environment variables", () => {
      const args = docker.buildRunArgs({
        name: "myapp",
        image: "nginx:alpine",
        internalPort: 80,
        env: { NODE_ENV: "production", API_KEY: "secret" },
        volumes: [],
        restartPolicy: "unless-stopped",
        network: "siteio-network",
        labels: {},
      })

      expect(args).toContain("-e")
      expect(args).toContain("NODE_ENV=production")
      expect(args).toContain("API_KEY=secret")
    })

    test("should include volume mounts", () => {
      const args = docker.buildRunArgs({
        name: "myapp",
        image: "nginx:alpine",
        internalPort: 80,
        env: {},
        volumes: [{ name: "data", mountPath: "/app/data" }],
        restartPolicy: "unless-stopped",
        network: "siteio-network",
        labels: {},
      })

      expect(args).toContain("-v")
      expect(args.some((a) => a.includes(":/app/data"))).toBe(true)
    })

    test("should include labels", () => {
      const args = docker.buildRunArgs({
        name: "myapp",
        image: "nginx:alpine",
        internalPort: 80,
        env: {},
        volumes: [],
        restartPolicy: "unless-stopped",
        network: "siteio-network",
        labels: {
          "traefik.enable": "true",
          "traefik.http.routers.myapp.rule": "Host(`myapp.example.com`)",
        },
      })

      expect(args).toContain("-l")
      expect(args).toContain("traefik.enable=true")
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/docker.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

Create `src/lib/agent/docker.ts`:

```typescript
import { spawnSync } from "bun"
import { join } from "path"
import type { ContainerInspect, RestartPolicy, VolumeMount } from "../../types"
import { SiteioError } from "../../utils/errors"

export interface ContainerRunConfig {
  name: string
  image: string
  internalPort: number
  env: Record<string, string>
  volumes: VolumeMount[]
  restartPolicy: RestartPolicy
  network: string
  labels: Record<string, string>
  command?: string[]
}

export class DockerManager {
  private dataDir: string
  private volumesDir: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.volumesDir = join(dataDir, "volumes")
  }

  /**
   * Check if Docker daemon is available
   */
  isAvailable(): boolean {
    const result = spawnSync({
      cmd: ["docker", "info"],
      stdout: "pipe",
      stderr: "pipe",
    })
    return result.exitCode === 0
  }

  /**
   * Generate the siteio container name for an app
   */
  containerName(appName: string): string {
    return `siteio-${appName}`
  }

  /**
   * Parse a port mapping string
   */
  parsePortMapping(port: string): { containerPort: number; hostPort?: number } {
    if (port.includes(":")) {
      const [host, container] = port.split(":")
      return { containerPort: parseInt(container!, 10), hostPort: parseInt(host!, 10) }
    }
    return { containerPort: parseInt(port, 10) }
  }

  /**
   * Build docker run arguments from config
   */
  buildRunArgs(config: ContainerRunConfig): string[] {
    const containerName = this.containerName(config.name)
    const args: string[] = [
      "run",
      "-d",
      "--name",
      containerName,
      "--network",
      config.network,
      "--restart",
      config.restartPolicy,
    ]

    // Add environment variables
    for (const [key, value] of Object.entries(config.env)) {
      args.push("-e", `${key}=${value}`)
    }

    // Add volume mounts
    for (const vol of config.volumes) {
      const hostPath = join(this.volumesDir, config.name, vol.name)
      args.push("-v", `${hostPath}:${vol.mountPath}`)
    }

    // Add labels
    for (const [key, value] of Object.entries(config.labels)) {
      args.push("-l", `${key}=${value}`)
    }

    // Add command if specified
    if (config.command && config.command.length > 0) {
      args.push(config.image, ...config.command)
    } else {
      args.push(config.image)
    }

    return args
  }

  /**
   * Ensure the siteio-network exists
   */
  ensureNetwork(networkName: string = "siteio-network"): void {
    // Check if network exists
    const inspect = spawnSync({
      cmd: ["docker", "network", "inspect", networkName],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (inspect.exitCode !== 0) {
      // Create network
      const create = spawnSync({
        cmd: ["docker", "network", "create", networkName],
        stdout: "pipe",
        stderr: "pipe",
      })

      if (create.exitCode !== 0) {
        throw new SiteioError(`Failed to create Docker network: ${create.stderr.toString()}`)
      }
    }
  }

  /**
   * Pull a Docker image
   */
  async pull(image: string): Promise<void> {
    const result = spawnSync({
      cmd: ["docker", "pull", image],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (result.exitCode !== 0) {
      throw new SiteioError(`Failed to pull image ${image}: ${result.stderr.toString()}`)
    }
  }

  /**
   * Run a container with the given configuration
   */
  async run(config: ContainerRunConfig): Promise<string> {
    const args = this.buildRunArgs(config)

    const result = spawnSync({
      cmd: ["docker", ...args],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (result.exitCode !== 0) {
      throw new SiteioError(`Failed to run container: ${result.stderr.toString()}`)
    }

    // Return container ID
    return result.stdout.toString().trim()
  }

  /**
   * Stop a container
   */
  async stop(appName: string): Promise<void> {
    const containerName = this.containerName(appName)
    const result = spawnSync({
      cmd: ["docker", "stop", containerName],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (result.exitCode !== 0) {
      throw new SiteioError(`Failed to stop container: ${result.stderr.toString()}`)
    }
  }

  /**
   * Remove a container
   */
  async remove(appName: string): Promise<void> {
    const containerName = this.containerName(appName)
    const result = spawnSync({
      cmd: ["docker", "rm", "-f", containerName],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (result.exitCode !== 0 && !result.stderr.toString().includes("No such container")) {
      throw new SiteioError(`Failed to remove container: ${result.stderr.toString()}`)
    }
  }

  /**
   * Get container logs
   */
  async logs(appName: string, tail: number = 100): Promise<string> {
    const containerName = this.containerName(appName)
    const result = spawnSync({
      cmd: ["docker", "logs", "--tail", tail.toString(), containerName],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (result.exitCode !== 0) {
      throw new SiteioError(`Failed to get logs: ${result.stderr.toString()}`)
    }

    // Docker sends logs to both stdout and stderr
    return result.stdout.toString() + result.stderr.toString()
  }

  /**
   * Check if a container is running
   */
  isRunning(appName: string): boolean {
    const containerName = this.containerName(appName)
    const result = spawnSync({
      cmd: ["docker", "inspect", "-f", "{{.State.Running}}", containerName],
      stdout: "pipe",
      stderr: "pipe",
    })

    return result.exitCode === 0 && result.stdout.toString().trim() === "true"
  }

  /**
   * Check if a container exists (running or stopped)
   */
  containerExists(appName: string): boolean {
    const containerName = this.containerName(appName)
    const result = spawnSync({
      cmd: ["docker", "inspect", containerName],
      stdout: "pipe",
      stderr: "pipe",
    })

    return result.exitCode === 0
  }

  /**
   * Inspect a container
   */
  async inspect(appName: string): Promise<ContainerInspect | null> {
    const containerName = this.containerName(appName)
    const result = spawnSync({
      cmd: ["docker", "inspect", containerName],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (result.exitCode !== 0) {
      return null
    }

    try {
      const data = JSON.parse(result.stdout.toString())[0]
      return {
        id: data.Id,
        name: data.Name.replace(/^\//, ""),
        state: {
          running: data.State.Running,
          status: data.State.Status,
          startedAt: data.State.StartedAt,
          exitCode: data.State.ExitCode,
        },
        image: data.Config.Image,
        ports: data.NetworkSettings?.Ports || {},
      }
    } catch {
      return null
    }
  }

  /**
   * Restart a container
   */
  async restart(appName: string): Promise<void> {
    const containerName = this.containerName(appName)
    const result = spawnSync({
      cmd: ["docker", "restart", containerName],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (result.exitCode !== 0) {
      throw new SiteioError(`Failed to restart container: ${result.stderr.toString()}`)
    }
  }

  /**
   * Build Traefik labels for routing
   */
  buildTraefikLabels(
    appName: string,
    domains: string[],
    internalPort: number,
    useHttps: boolean = true
  ): Record<string, string> {
    const labels: Record<string, string> = {
      "traefik.enable": "true",
      [`traefik.http.services.${appName}.loadbalancer.server.port`]: internalPort.toString(),
    }

    // Build host rules for all domains
    const hostRules = domains.map((d) => `Host(\`${d}\`)`).join(" || ")

    if (useHttps) {
      labels[`traefik.http.routers.${appName}.rule`] = hostRules
      labels[`traefik.http.routers.${appName}.entrypoints`] = "websecure"
      labels[`traefik.http.routers.${appName}.tls.certresolver`] = "letsencrypt"
    } else {
      labels[`traefik.http.routers.${appName}.rule`] = hostRules
      labels[`traefik.http.routers.${appName}.entrypoints`] = "web"
    }

    return labels
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/docker.test.ts`
Expected: PASS

**Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/agent/docker.ts src/__tests__/docker.test.ts
git commit -m "$(cat <<'EOF'
feat: add DockerManager class for container lifecycle

DockerManager provides methods for:
- Checking Docker availability
- Building docker run arguments
- Container lifecycle (pull, run, stop, remove, restart)
- Getting container logs
- Inspecting container state
- Building Traefik labels for routing

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Add App API Endpoints to Server

**Files:**
- Modify: `src/lib/agent/server.ts`
- Test: `src/__tests__/apps-api.test.ts`

**Step 1: Write the failing test**

Create `src/__tests__/apps-api.test.ts`:

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AgentServer } from "../lib/agent/server"

describe("Apps API", () => {
  let testDir: string
  let server: AgentServer
  let baseUrl: string
  const apiKey = "test-api-key"
  const testPort = 4567

  beforeAll(async () => {
    testDir = mkdtempSync(join(tmpdir(), "siteio-apps-api-test-"))

    server = new AgentServer({
      domain: "test.example.com",
      apiKey,
      dataDir: testDir,
      port: testPort,
      skipTraefik: true,
    })

    await server.start()
    baseUrl = `http://localhost:${testPort}`
  })

  afterAll(async () => {
    await server.stop()
    rmSync(testDir, { recursive: true, force: true })
  })

  const request = async (method: string, path: string, body?: object) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "X-API-Key": apiKey,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    return {
      status: response.status,
      data: await response.json(),
    }
  }

  describe("POST /apps", () => {
    test("should create an app", async () => {
      const { status, data } = await request("POST", "/apps", {
        name: "testapp",
        image: "nginx:alpine",
        internalPort: 80,
      })

      expect(status).toBe(201)
      expect(data.success).toBe(true)
      expect(data.data.name).toBe("testapp")
      expect(data.data.status).toBe("pending")
    })

    test("should reject invalid app name", async () => {
      const { status, data } = await request("POST", "/apps", {
        name: "Invalid Name",
        image: "nginx:alpine",
      })

      expect(status).toBe(400)
      expect(data.success).toBe(false)
    })

    test("should reject duplicate app name", async () => {
      await request("POST", "/apps", {
        name: "duplicate",
        image: "nginx:alpine",
      })

      const { status, data } = await request("POST", "/apps", {
        name: "duplicate",
        image: "nginx:alpine",
      })

      expect(status).toBe(400)
      expect(data.success).toBe(false)
    })
  })

  describe("GET /apps", () => {
    test("should list all apps", async () => {
      // Create a couple of apps first
      await request("POST", "/apps", { name: "listapp1", image: "nginx:alpine" })
      await request("POST", "/apps", { name: "listapp2", image: "nginx:alpine" })

      const { status, data } = await request("GET", "/apps")

      expect(status).toBe(200)
      expect(data.success).toBe(true)
      expect(Array.isArray(data.data)).toBe(true)
      expect(data.data.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe("GET /apps/:name", () => {
    test("should get app details", async () => {
      await request("POST", "/apps", {
        name: "detailapp",
        image: "nginx:alpine",
        internalPort: 8080,
      })

      const { status, data } = await request("GET", "/apps/detailapp")

      expect(status).toBe(200)
      expect(data.success).toBe(true)
      expect(data.data.name).toBe("detailapp")
      expect(data.data.internalPort).toBe(8080)
    })

    test("should return 404 for non-existent app", async () => {
      const { status, data } = await request("GET", "/apps/nonexistent")

      expect(status).toBe(404)
      expect(data.success).toBe(false)
    })
  })

  describe("PATCH /apps/:name", () => {
    test("should update app config", async () => {
      await request("POST", "/apps", {
        name: "updateapp",
        image: "nginx:alpine",
      })

      const { status, data } = await request("PATCH", "/apps/updateapp", {
        env: { NODE_ENV: "production" },
        domains: ["updateapp.example.com"],
      })

      expect(status).toBe(200)
      expect(data.success).toBe(true)
      expect(data.data.env.NODE_ENV).toBe("production")
      expect(data.data.domains).toContain("updateapp.example.com")
    })
  })

  describe("DELETE /apps/:name", () => {
    test("should delete an app", async () => {
      await request("POST", "/apps", { name: "deleteapp", image: "nginx:alpine" })

      const { status, data } = await request("DELETE", "/apps/deleteapp")

      expect(status).toBe(200)
      expect(data.success).toBe(true)

      // Verify it's deleted
      const { status: getStatus } = await request("GET", "/apps/deleteapp")
      expect(getStatus).toBe(404)
    })
  })

  describe("Authentication", () => {
    test("should reject requests without API key", async () => {
      const response = await fetch(`${baseUrl}/apps`, {
        method: "GET",
      })

      expect(response.status).toBe(401)
    })

    test("should reject requests with invalid API key", async () => {
      const response = await fetch(`${baseUrl}/apps`, {
        method: "GET",
        headers: { "X-API-Key": "wrong-key" },
      })

      expect(response.status).toBe(401)
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/apps-api.test.ts`
Expected: FAIL (routes don't exist yet)

**Step 3: Update server.ts to add App routes**

In `src/lib/agent/server.ts`, add these imports at the top:

```typescript
import { AppStorage } from "./app-storage"
import { DockerManager } from "./docker"
```

Add these properties to the `AgentServer` class:

```typescript
private appStorage: AppStorage
private docker: DockerManager
```

In the constructor, after `this.storage = new SiteStorage(config.dataDir)`, add:

```typescript
this.appStorage = new AppStorage(config.dataDir)
this.docker = new DockerManager(config.dataDir)
```

In `handleRequest`, add these route handlers after the existing site routes (before the final 404):

```typescript
// Apps API routes
// GET /apps - list all apps
if (path === "/apps" && method === "GET") {
  return this.handleListApps()
}

// POST /apps - create app
if (path === "/apps" && method === "POST") {
  return this.handleCreateApp(req)
}

// GET /apps/:name - get app details
const getAppMatch = path.match(/^\/apps\/([a-z0-9-]+)$/)
if (getAppMatch && method === "GET") {
  return this.handleGetApp(getAppMatch[1]!)
}

// PATCH /apps/:name - update app
if (getAppMatch && method === "PATCH") {
  return this.handleUpdateApp(getAppMatch[1]!, req)
}

// DELETE /apps/:name - delete app
if (getAppMatch && method === "DELETE") {
  return this.handleDeleteApp(getAppMatch[1]!)
}

// POST /apps/:name/deploy - deploy app
const deployAppMatch = path.match(/^\/apps\/([a-z0-9-]+)\/deploy$/)
if (deployAppMatch && method === "POST") {
  return this.handleDeployApp(deployAppMatch[1]!)
}

// POST /apps/:name/stop - stop app
const stopAppMatch = path.match(/^\/apps\/([a-z0-9-]+)\/stop$/)
if (stopAppMatch && method === "POST") {
  return this.handleStopApp(stopAppMatch[1]!)
}

// POST /apps/:name/restart - restart app
const restartAppMatch = path.match(/^\/apps\/([a-z0-9-]+)\/restart$/)
if (restartAppMatch && method === "POST") {
  return this.handleRestartApp(restartAppMatch[1]!)
}

// GET /apps/:name/logs - get app logs
const logsAppMatch = path.match(/^\/apps\/([a-z0-9-]+)\/logs$/)
if (logsAppMatch && method === "GET") {
  return this.handleGetAppLogs(logsAppMatch[1]!, req)
}
```

Add these handler methods to the class:

```typescript
private handleListApps(): Response {
  const apps = this.appStorage.list()
  return this.json(apps.map((a) => this.appStorage.toInfo(a)))
}

private async handleCreateApp(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const { name, image, internalPort = 80, env = {}, volumes = [], domains = [], restartPolicy = "unless-stopped" } = body

    if (!name || !image) {
      return this.error("name and image are required", 400)
    }

    const app = this.appStorage.create({
      name,
      type: "container",
      image,
      internalPort,
      env,
      volumes,
      domains,
      restartPolicy,
      status: "pending",
    })

    return this.json(this.appStorage.toInfo(app), 201)
  } catch (err) {
    if (err instanceof Error && err.message.includes("already exists")) {
      return this.error(err.message, 400)
    }
    if (err instanceof Error && (err.message.includes("must contain") || err.message.includes("reserved"))) {
      return this.error(err.message, 400)
    }
    throw err
  }
}

private handleGetApp(name: string): Response {
  const app = this.appStorage.get(name)
  if (!app) {
    return this.error(`App '${name}' not found`, 404)
  }
  return this.json(app)
}

private async handleUpdateApp(name: string, req: Request): Promise<Response> {
  const app = this.appStorage.get(name)
  if (!app) {
    return this.error(`App '${name}' not found`, 404)
  }

  const body = await req.json()
  const { env, volumes, domains, internalPort, restartPolicy, image } = body

  const updates: Record<string, unknown> = {}
  if (env !== undefined) updates.env = { ...app.env, ...env }
  if (volumes !== undefined) updates.volumes = volumes
  if (domains !== undefined) updates.domains = domains
  if (internalPort !== undefined) updates.internalPort = internalPort
  if (restartPolicy !== undefined) updates.restartPolicy = restartPolicy
  if (image !== undefined) updates.image = image

  const updated = this.appStorage.update(name, updates)
  return this.json(updated)
}

private async handleDeleteApp(name: string): Promise<Response> {
  const app = this.appStorage.get(name)
  if (!app) {
    return this.error(`App '${name}' not found`, 404)
  }

  // Stop and remove container if running
  if (app.containerId) {
    try {
      await this.docker.remove(name)
    } catch {
      // Container may already be removed
    }
  }

  this.appStorage.delete(name)
  return this.json({ deleted: true })
}

private async handleDeployApp(name: string): Promise<Response> {
  const app = this.appStorage.get(name)
  if (!app) {
    return this.error(`App '${name}' not found`, 404)
  }

  // Check Docker availability
  if (!this.docker.isAvailable()) {
    return this.error("Docker is not available", 500)
  }

  try {
    // Remove existing container if any
    if (this.docker.containerExists(name)) {
      await this.docker.remove(name)
    }

    // Ensure network exists
    this.docker.ensureNetwork()

    // Pull the image
    await this.docker.pull(app.image)

    // Build Traefik labels
    const labels = this.docker.buildTraefikLabels(
      name,
      app.domains.length > 0 ? app.domains : [`${name}.${this.config.domain}`],
      app.internalPort,
      !this.config.skipTraefik
    )

    // Run the container
    const containerId = await this.docker.run({
      name,
      image: app.image,
      internalPort: app.internalPort,
      env: app.env,
      volumes: app.volumes,
      restartPolicy: app.restartPolicy,
      network: "siteio-network",
      labels,
    })

    // Update app status
    const updated = this.appStorage.update(name, {
      containerId,
      status: "running",
      deployedAt: new Date().toISOString(),
    })

    return this.json(this.appStorage.toInfo(updated!))
  } catch (err) {
    this.appStorage.update(name, { status: "failed" })
    return this.error(err instanceof Error ? err.message : "Deploy failed", 500)
  }
}

private async handleStopApp(name: string): Promise<Response> {
  const app = this.appStorage.get(name)
  if (!app) {
    return this.error(`App '${name}' not found`, 404)
  }

  try {
    await this.docker.stop(name)
    const updated = this.appStorage.update(name, { status: "stopped" })
    return this.json(this.appStorage.toInfo(updated!))
  } catch (err) {
    return this.error(err instanceof Error ? err.message : "Stop failed", 500)
  }
}

private async handleRestartApp(name: string): Promise<Response> {
  const app = this.appStorage.get(name)
  if (!app) {
    return this.error(`App '${name}' not found`, 404)
  }

  try {
    await this.docker.restart(name)
    const updated = this.appStorage.update(name, { status: "running" })
    return this.json(this.appStorage.toInfo(updated!))
  } catch (err) {
    return this.error(err instanceof Error ? err.message : "Restart failed", 500)
  }
}

private async handleGetAppLogs(name: string, req: Request): Promise<Response> {
  const app = this.appStorage.get(name)
  if (!app) {
    return this.error(`App '${name}' not found`, 404)
  }

  const url = new URL(req.url)
  const tail = parseInt(url.searchParams.get("tail") || "100", 10)

  try {
    const logs = await this.docker.logs(name, tail)
    return this.json({ name, logs, lines: tail })
  } catch (err) {
    return this.error(err instanceof Error ? err.message : "Failed to get logs", 500)
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/apps-api.test.ts`
Expected: PASS (most tests - deploy/stop/restart may skip if Docker unavailable)

**Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 6: Run all tests**

Run: `bun test`
Expected: PASS

**Step 7: Commit**

```bash
git add src/lib/agent/server.ts src/__tests__/apps-api.test.ts
git commit -m "$(cat <<'EOF'
feat: add Apps API endpoints to agent server

Add REST API for container management:
- POST /apps - create app
- GET /apps - list all apps
- GET /apps/:name - get app details
- PATCH /apps/:name - update app config
- DELETE /apps/:name - delete app
- POST /apps/:name/deploy - deploy container
- POST /apps/:name/stop - stop container
- POST /apps/:name/restart - restart container
- GET /apps/:name/logs - get container logs

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Add App Methods to SiteioClient

**Files:**
- Modify: `src/lib/client.ts`

**Step 1: Add app method types**

In `src/lib/client.ts`, add these imports at the top (update existing import):

```typescript
import type { SiteInfo, SiteOAuth, ApiResponse, App, AppInfo, ContainerLogs } from "../types"
```

**Step 2: Add app methods to the SiteioClient class**

Add these methods to the `SiteioClient` class:

```typescript
// Apps API

async createApp(config: {
  name: string
  image: string
  internalPort?: number
  env?: Record<string, string>
  volumes?: { name: string; mountPath: string }[]
  domains?: string[]
  restartPolicy?: string
}): Promise<AppInfo> {
  return this.request<AppInfo>("POST", "/apps", JSON.stringify(config), {
    "Content-Type": "application/json",
  })
}

async listApps(): Promise<AppInfo[]> {
  return this.request<AppInfo[]>("GET", "/apps")
}

async getApp(name: string): Promise<App> {
  return this.request<App>("GET", `/apps/${name}`)
}

async updateApp(
  name: string,
  updates: {
    env?: Record<string, string>
    volumes?: { name: string; mountPath: string }[]
    domains?: string[]
    internalPort?: number
    restartPolicy?: string
    image?: string
  }
): Promise<App> {
  return this.request<App>("PATCH", `/apps/${name}`, JSON.stringify(updates), {
    "Content-Type": "application/json",
  })
}

async deleteApp(name: string): Promise<void> {
  await this.request<{ deleted: boolean }>("DELETE", `/apps/${name}`)
}

async deployApp(name: string): Promise<AppInfo> {
  return this.request<AppInfo>("POST", `/apps/${name}/deploy`)
}

async stopApp(name: string): Promise<AppInfo> {
  return this.request<AppInfo>("POST", `/apps/${name}/stop`)
}

async restartApp(name: string): Promise<AppInfo> {
  return this.request<AppInfo>("POST", `/apps/${name}/restart`)
}

async getAppLogs(name: string, tail: number = 100): Promise<ContainerLogs> {
  return this.request<ContainerLogs>("GET", `/apps/${name}/logs?tail=${tail}`)
}
```

**Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/lib/client.ts
git commit -m "$(cat <<'EOF'
feat: add app methods to SiteioClient

Add client methods for container management:
- createApp, listApps, getApp, updateApp, deleteApp
- deployApp, stopApp, restartApp
- getAppLogs

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Create Apps CLI Commands

**Files:**
- Create: `src/commands/apps/create.ts`
- Create: `src/commands/apps/list.ts`
- Create: `src/commands/apps/info.ts`
- Create: `src/commands/apps/deploy.ts`
- Create: `src/commands/apps/stop.ts`
- Create: `src/commands/apps/restart.ts`
- Create: `src/commands/apps/rm.ts`
- Create: `src/commands/apps/logs.ts`
- Create: `src/commands/apps/set.ts`
- Modify: `src/cli.ts`

**Step 1: Create apps directory**

Run: `mkdir -p src/commands/apps`

**Step 2: Create create.ts**

Create `src/commands/apps/create.ts`:

```typescript
import ora from "ora"
import { loadConfig } from "../../config/loader"
import { SiteioClient } from "../../lib/client"
import { handleError } from "../../utils/errors"
import { formatSuccess } from "../../utils/output"

interface CreateOptions {
  image?: string
  git?: string
  branch?: string
  port?: string
  json?: boolean
}

export async function createAppCommand(name: string, options: CreateOptions): Promise<void> {
  const spinner = ora("Creating app...").start()

  try {
    const config = loadConfig()
    if (!config.apiUrl || !config.apiKey) {
      throw new Error("Not logged in. Run: siteio login")
    }

    const client = new SiteioClient(config.apiUrl, config.apiKey)

    if (!options.image && !options.git) {
      throw new Error("Either --image or --git is required")
    }

    const app = await client.createApp({
      name,
      image: options.image || "placeholder", // TODO: handle git builds
      internalPort: options.port ? parseInt(options.port, 10) : 80,
    })

    spinner.succeed(formatSuccess(`App '${name}' created`))

    if (options.json) {
      console.log(JSON.stringify(app, null, 2))
    } else {
      console.error(`\nNext steps:`)
      console.error(`  siteio apps set ${name} -d ${name}.yourdomain.com`)
      console.error(`  siteio apps deploy ${name}`)
    }
  } catch (error) {
    spinner.fail()
    handleError(error)
  }
}
```

**Step 3: Create list.ts**

Create `src/commands/apps/list.ts`:

```typescript
import ora from "ora"
import { loadConfig } from "../../config/loader"
import { SiteioClient } from "../../lib/client"
import { handleError } from "../../utils/errors"
import { formatTable } from "../../utils/output"

interface ListOptions {
  json?: boolean
}

export async function listAppsCommand(options: ListOptions): Promise<void> {
  const spinner = ora("Fetching apps...").start()

  try {
    const config = loadConfig()
    if (!config.apiUrl || !config.apiKey) {
      throw new Error("Not logged in. Run: siteio login")
    }

    const client = new SiteioClient(config.apiUrl, config.apiKey)
    const apps = await client.listApps()

    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify(apps, null, 2))
    } else if (apps.length === 0) {
      console.error("No apps deployed")
    } else {
      const headers = ["Name", "Image", "Status", "Domains", "Port"]
      const rows = apps.map((app) => [
        app.name,
        app.image,
        app.status,
        app.domains.join(", ") || "-",
        app.internalPort.toString(),
      ])
      console.log(formatTable(headers, rows))
    }

    process.exit(0)
  } catch (error) {
    spinner.fail()
    handleError(error)
  }
}
```

**Step 4: Create info.ts**

Create `src/commands/apps/info.ts`:

```typescript
import ora from "ora"
import chalk from "chalk"
import { loadConfig } from "../../config/loader"
import { SiteioClient } from "../../lib/client"
import { handleError } from "../../utils/errors"

interface InfoOptions {
  json?: boolean
}

export async function infoAppCommand(name: string, options: InfoOptions): Promise<void> {
  const spinner = ora("Fetching app info...").start()

  try {
    const config = loadConfig()
    if (!config.apiUrl || !config.apiKey) {
      throw new Error("Not logged in. Run: siteio login")
    }

    const client = new SiteioClient(config.apiUrl, config.apiKey)
    const app = await client.getApp(name)

    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify(app, null, 2))
    } else {
      console.log(chalk.bold(`App: ${app.name}`))
      console.log(`  Type:     ${app.type}`)
      console.log(`  Image:    ${app.image}`)
      console.log(`  Status:   ${app.status}`)
      console.log(`  Port:     ${app.internalPort}`)
      console.log(`  Restart:  ${app.restartPolicy}`)
      console.log(`  Domains:  ${app.domains.join(", ") || "(none)"}`)
      if (Object.keys(app.env).length > 0) {
        console.log(`  Env vars: ${Object.keys(app.env).join(", ")}`)
      }
      if (app.volumes.length > 0) {
        console.log(`  Volumes:  ${app.volumes.map((v) => `${v.name}:${v.mountPath}`).join(", ")}`)
      }
      if (app.deployedAt) {
        console.log(`  Deployed: ${new Date(app.deployedAt).toLocaleString()}`)
      }
      console.log(`  Created:  ${new Date(app.createdAt).toLocaleString()}`)
    }

    process.exit(0)
  } catch (error) {
    spinner.fail()
    handleError(error)
  }
}
```

**Step 5: Create deploy.ts**

Create `src/commands/apps/deploy.ts`:

```typescript
import ora from "ora"
import { loadConfig } from "../../config/loader"
import { SiteioClient } from "../../lib/client"
import { handleError } from "../../utils/errors"
import { formatSuccess } from "../../utils/output"

interface DeployOptions {
  json?: boolean
}

export async function deployAppCommand(name: string, options: DeployOptions): Promise<void> {
  const spinner = ora("Deploying app...").start()

  try {
    const config = loadConfig()
    if (!config.apiUrl || !config.apiKey) {
      throw new Error("Not logged in. Run: siteio login")
    }

    const client = new SiteioClient(config.apiUrl, config.apiKey)

    spinner.text = "Pulling image..."
    const app = await client.deployApp(name)

    spinner.succeed(formatSuccess(`App '${name}' deployed`))

    if (options.json) {
      console.log(JSON.stringify(app, null, 2))
    } else {
      if (app.domains.length > 0) {
        console.error(`\nAvailable at:`)
        for (const domain of app.domains) {
          console.error(`  https://${domain}`)
        }
      }
    }

    process.exit(0)
  } catch (error) {
    spinner.fail()
    handleError(error)
  }
}
```

**Step 6: Create stop.ts**

Create `src/commands/apps/stop.ts`:

```typescript
import ora from "ora"
import { loadConfig } from "../../config/loader"
import { SiteioClient } from "../../lib/client"
import { handleError } from "../../utils/errors"
import { formatSuccess } from "../../utils/output"

interface StopOptions {
  json?: boolean
}

export async function stopAppCommand(name: string, options: StopOptions): Promise<void> {
  const spinner = ora("Stopping app...").start()

  try {
    const config = loadConfig()
    if (!config.apiUrl || !config.apiKey) {
      throw new Error("Not logged in. Run: siteio login")
    }

    const client = new SiteioClient(config.apiUrl, config.apiKey)
    const app = await client.stopApp(name)

    spinner.succeed(formatSuccess(`App '${name}' stopped`))

    if (options.json) {
      console.log(JSON.stringify(app, null, 2))
    }

    process.exit(0)
  } catch (error) {
    spinner.fail()
    handleError(error)
  }
}
```

**Step 7: Create restart.ts**

Create `src/commands/apps/restart.ts`:

```typescript
import ora from "ora"
import { loadConfig } from "../../config/loader"
import { SiteioClient } from "../../lib/client"
import { handleError } from "../../utils/errors"
import { formatSuccess } from "../../utils/output"

interface RestartOptions {
  json?: boolean
}

export async function restartAppCommand(name: string, options: RestartOptions): Promise<void> {
  const spinner = ora("Restarting app...").start()

  try {
    const config = loadConfig()
    if (!config.apiUrl || !config.apiKey) {
      throw new Error("Not logged in. Run: siteio login")
    }

    const client = new SiteioClient(config.apiUrl, config.apiKey)
    const app = await client.restartApp(name)

    spinner.succeed(formatSuccess(`App '${name}' restarted`))

    if (options.json) {
      console.log(JSON.stringify(app, null, 2))
    }

    process.exit(0)
  } catch (error) {
    spinner.fail()
    handleError(error)
  }
}
```

**Step 8: Create rm.ts**

Create `src/commands/apps/rm.ts`:

```typescript
import ora from "ora"
import { loadConfig } from "../../config/loader"
import { SiteioClient } from "../../lib/client"
import { handleError } from "../../utils/errors"
import { formatSuccess } from "../../utils/output"

interface RmOptions {
  json?: boolean
  force?: boolean
}

export async function rmAppCommand(name: string, options: RmOptions): Promise<void> {
  const spinner = ora("Removing app...").start()

  try {
    const config = loadConfig()
    if (!config.apiUrl || !config.apiKey) {
      throw new Error("Not logged in. Run: siteio login")
    }

    const client = new SiteioClient(config.apiUrl, config.apiKey)
    await client.deleteApp(name)

    spinner.succeed(formatSuccess(`App '${name}' removed`))

    if (options.json) {
      console.log(JSON.stringify({ deleted: true }, null, 2))
    }

    process.exit(0)
  } catch (error) {
    spinner.fail()
    handleError(error)
  }
}
```

**Step 9: Create logs.ts**

Create `src/commands/apps/logs.ts`:

```typescript
import ora from "ora"
import { loadConfig } from "../../config/loader"
import { SiteioClient } from "../../lib/client"
import { handleError } from "../../utils/errors"

interface LogsOptions {
  tail?: string
  json?: boolean
}

export async function logsAppCommand(name: string, options: LogsOptions): Promise<void> {
  const spinner = ora("Fetching logs...").start()

  try {
    const config = loadConfig()
    if (!config.apiUrl || !config.apiKey) {
      throw new Error("Not logged in. Run: siteio login")
    }

    const client = new SiteioClient(config.apiUrl, config.apiKey)
    const tail = options.tail ? parseInt(options.tail, 10) : 100
    const result = await client.getAppLogs(name, tail)

    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(result.logs)
    }

    process.exit(0)
  } catch (error) {
    spinner.fail()
    handleError(error)
  }
}
```

**Step 10: Create set.ts**

Create `src/commands/apps/set.ts`:

```typescript
import ora from "ora"
import { loadConfig } from "../../config/loader"
import { SiteioClient } from "../../lib/client"
import { handleError } from "../../utils/errors"
import { formatSuccess } from "../../utils/output"

interface SetOptions {
  env?: string[]
  volume?: string[]
  domain?: string[]
  port?: string
  restart?: string
  json?: boolean
}

export async function setAppCommand(name: string, options: SetOptions): Promise<void> {
  const spinner = ora("Updating app...").start()

  try {
    const config = loadConfig()
    if (!config.apiUrl || !config.apiKey) {
      throw new Error("Not logged in. Run: siteio login")
    }

    const client = new SiteioClient(config.apiUrl, config.apiKey)

    // Get current app to merge settings
    const current = await client.getApp(name)

    const updates: Record<string, unknown> = {}

    // Parse environment variables
    if (options.env && options.env.length > 0) {
      const env = { ...current.env }
      for (const e of options.env) {
        const [key, ...valueParts] = e.split("=")
        if (key) {
          env[key] = valueParts.join("=")
        }
      }
      updates.env = env
    }

    // Parse volumes
    if (options.volume && options.volume.length > 0) {
      const volumes = [...current.volumes]
      for (const v of options.volume) {
        const [volName, mountPath] = v.split(":")
        if (volName && mountPath) {
          // Remove existing volume with same name
          const idx = volumes.findIndex((vol) => vol.name === volName)
          if (idx >= 0) volumes.splice(idx, 1)
          volumes.push({ name: volName, mountPath })
        }
      }
      updates.volumes = volumes
    }

    // Parse domains
    if (options.domain && options.domain.length > 0) {
      const domains = new Set(current.domains)
      for (const d of options.domain) {
        domains.add(d)
      }
      updates.domains = Array.from(domains)
    }

    // Port
    if (options.port) {
      updates.internalPort = parseInt(options.port, 10)
    }

    // Restart policy
    if (options.restart) {
      updates.restartPolicy = options.restart
    }

    if (Object.keys(updates).length === 0) {
      spinner.fail("No settings to update")
      process.exit(1)
    }

    const app = await client.updateApp(name, updates)

    spinner.succeed(formatSuccess(`App '${name}' updated`))

    if (options.json) {
      console.log(JSON.stringify(app, null, 2))
    } else {
      console.error("\nNote: Run 'siteio apps deploy' to apply changes")
    }

    process.exit(0)
  } catch (error) {
    spinner.fail()
    handleError(error)
  }
}
```

**Step 11: Update cli.ts to add apps commands**

In `src/cli.ts`, add the apps command group. Find the section with other command groups and add:

```typescript
// Apps commands
const apps = program.command("apps").description("Manage container apps")

apps
  .command("create <name>")
  .description("Create a new app")
  .option("--image <image>", "Docker image to deploy")
  .option("--git <repo>", "Git repository URL")
  .option("--branch <branch>", "Git branch (default: main)")
  .option("--port <port>", "Internal container port (default: 80)")
  .action(async (name, options) => {
    const { createAppCommand } = await import("./commands/apps/create.ts")
    await createAppCommand(name, { ...options, json: program.opts().json })
  })

apps
  .command("ls")
  .alias("list")
  .description("List all apps")
  .action(async () => {
    const { listAppsCommand } = await import("./commands/apps/list.ts")
    await listAppsCommand({ json: program.opts().json })
  })

apps
  .command("info <name>")
  .description("Show app details")
  .action(async (name) => {
    const { infoAppCommand } = await import("./commands/apps/info.ts")
    await infoAppCommand(name, { json: program.opts().json })
  })

apps
  .command("deploy <name>")
  .description("Deploy an app")
  .action(async (name) => {
    const { deployAppCommand } = await import("./commands/apps/deploy.ts")
    await deployAppCommand(name, { json: program.opts().json })
  })

apps
  .command("stop <name>")
  .description("Stop an app")
  .action(async (name) => {
    const { stopAppCommand } = await import("./commands/apps/stop.ts")
    await stopAppCommand(name, { json: program.opts().json })
  })

apps
  .command("restart <name>")
  .description("Restart an app")
  .action(async (name) => {
    const { restartAppCommand } = await import("./commands/apps/restart.ts")
    await restartAppCommand(name, { json: program.opts().json })
  })

apps
  .command("rm <name>")
  .description("Remove an app")
  .option("-f, --force", "Force removal")
  .action(async (name, options) => {
    const { rmAppCommand } = await import("./commands/apps/rm.ts")
    await rmAppCommand(name, { ...options, json: program.opts().json })
  })

apps
  .command("logs <name>")
  .description("View app logs")
  .option("--tail <lines>", "Number of lines to show (default: 100)")
  .action(async (name, options) => {
    const { logsAppCommand } = await import("./commands/apps/logs.ts")
    await logsAppCommand(name, { ...options, json: program.opts().json })
  })

apps
  .command("set <name>")
  .description("Configure app settings")
  .option("-e, --env <KEY=value...>", "Set environment variable")
  .option("-v, --volume <name:path...>", "Add volume mount")
  .option("-d, --domain <domain...>", "Add domain")
  .option("--port <port>", "Set internal port")
  .option("--restart <policy>", "Set restart policy (always|unless-stopped|on-failure|no)")
  .action(async (name, options) => {
    const { setAppCommand } = await import("./commands/apps/set.ts")
    await setAppCommand(name, { ...options, json: program.opts().json })
  })
```

**Step 12: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 13: Run all tests**

Run: `bun test`
Expected: PASS

**Step 14: Commit**

```bash
git add src/commands/apps/ src/cli.ts
git commit -m "$(cat <<'EOF'
feat: add apps CLI commands

Add CLI commands for container management:
- siteio apps create <name> --image <image>
- siteio apps ls
- siteio apps info <name>
- siteio apps deploy <name>
- siteio apps stop <name>
- siteio apps restart <name>
- siteio apps rm <name>
- siteio apps logs <name>
- siteio apps set <name> -e KEY=value -d domain.com

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Export New Modules from Index

**Files:**
- Modify: `src/index.ts`

**Step 1: Update exports**

Add these exports to `src/index.ts`:

```typescript
export { AppStorage } from "./lib/agent/app-storage"
export { DockerManager } from "./lib/agent/docker"
export type { ContainerRunConfig } from "./lib/agent/docker"
```

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat: export AppStorage and DockerManager from index

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2: Static Sites as Containers (Future)

> This phase converts static site deployment to use nginx containers instead of the custom fileserver. It should be implemented after Phase 1 is validated in production.

### Task 8-12: Reserved for Phase 2

These tasks will:
- Modify `POST /sites/:subdomain` to create nginx containers
- Remove `fileserver.ts` dependency
- Add `/auth/check` endpoint for OAuth with forwardAuth
- Update Traefik configuration generation
- Add migration command for existing sites

---

## Phase 3: Git Repository Builds (Future)

> This phase adds the ability to build Docker images from Git repositories.

### Task 13-16: Reserved for Phase 3

These tasks will:
- Create `src/lib/agent/git.ts` for repo cloning
- Add `src/lib/agent/credentials.ts` for registry/git auth
- Add `siteio git-credentials` CLI commands
- Extend `siteio apps create --git` to build from repos

---

## Summary

**Phase 1 implements:**
1. Container types in `types.ts`
2. `AppStorage` class for metadata persistence
3. `DockerManager` class for container lifecycle
4. Apps API endpoints in the agent server
5. App methods in `SiteioClient`
6. Full CLI for `siteio apps` commands
7. Module exports

**After Phase 1, users can:**
```bash
# Create and deploy a container app
siteio apps create myapi --image myregistry/myapi:latest --port 3000
siteio apps set myapi -d myapi.example.com
siteio apps set myapi -e DATABASE_URL=postgres://...
siteio apps deploy myapi

# Manage the app
siteio apps logs myapi
siteio apps restart myapi
siteio apps stop myapi
siteio apps rm myapi
```

**Existing static site commands continue to work unchanged.**
