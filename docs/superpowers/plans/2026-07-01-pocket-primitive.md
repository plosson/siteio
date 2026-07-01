# Pocket Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third first-class primitive, `pocket`, that deploys a PocketBase-backed site (static frontend + auth/storage/DB) with local Docker-free testing and one-command deploy.

**Architecture:** A `pocket` is one PocketBase container per site on the agent (server has Docker). User code (web root + `pb_migrations` + `pb_hooks`) is uploaded as a zip, extracted, and mounted **read-only**; `pb_data` lives on a **persistent volume** and is never touched by deploy. Locally, `pocket dev` runs the *same pinned PocketBase binary* directly — no Docker. Reuses `SiteStorage`'s extract/history pattern and `AppStorage`/`DockerManager`'s container/Traefik machinery; the only genuinely new subsystem is the pinned-binary manager + local runner.

**Tech Stack:** Bun, TypeScript, commander (CLI), fflate (zip/unzip), Docker (agent side only), PocketBase (shipped pinned image + downloaded pinned binary), Traefik (existing).

## Global Constraints

- **Runtime:** Bun. Tests run with `bun test`. Import local modules with explicit `.ts` extension (house style).
- **Dual output:** commands print JSON to **stdout** (when `--json`), human-readable to **stderr**. Follow `utils/output.ts` helpers.
- **Errors:** throw `ValidationError` / `ApiError` / `SiteioError` from `src/utils/errors.ts`; CLI commands funnel through `handleError`.
- **Name rules:** pocket names match `/^[a-z0-9-]+$/`; `api` is reserved (same as sites/apps).
- **Pinned version is a single source of truth:** `POCKETBASE_VERSION` in `src/lib/pocketbase-version.ts`. Local binary and prod image MUST reference it. Never hardcode the version elsewhere.
- **Deploy artifact boundary (never violate):** the deploy zip contains ONLY `public/**` (web root), `pb_migrations/**`, `pb_hooks/**`. It MUST NEVER include `.siteio/pb_data` or any cached binary.
- **Container port:** PocketBase listens on `8090` inside the container.
- **Plumbing lives under `.siteio/`:** `.siteio/pb_migrations`, `.siteio/pb_hooks`, `.siteio/pb_data` (local sandbox, gitignored).

---

## File Structure

**New files:**
- `src/lib/pocketbase-version.ts` — pinned version + image ref constants (shared client+server).
- `src/lib/pocketbase-binary.ts` — resolve/download/cache the pinned PocketBase binary (client-side, local dev).
- `src/lib/pocketbase-dev.ts` — build local `pocketbase serve` args + spawn the dev runner.
- `src/lib/pocket-scaffold.ts` — `pocket init` scaffold writer.
- `src/lib/agent/pocket-storage.ts` — `PocketStorage`: metadata CRUD + code extract/history + `pb_data` volume + system-hook injection.
- `src/commands/pocket/init.ts`, `dev.ts`, `deploy.ts`, `list.ts`, `info.ts`, `logs.ts`, `rm.ts`, `admin.ts` — CLI commands.
- `docker/pocketbase/Dockerfile`, `docker/pocketbase/entrypoint.sh` — the shipped `siteio-pocketbase` image.
- Tests: `src/__tests__/unit/pocketbase-binary.test.ts`, `pocketbase-dev.test.ts`, `pocket-scaffold.test.ts`, `pocket-storage.test.ts`; `src/__tests__/api/pockets.test.ts`.

**Modified files:**
- `src/types.ts` — add `Pocket`, `PocketInfo`; extend `SiteConfig`.
- `src/lib/client.ts` — pocket client methods.
- `src/lib/agent/server.ts` — instantiate `PocketStorage`, add `/pockets` routes + handlers.
- `src/cli.ts` — register the `pocket` command group.
- `src/utils/site-config.ts` — `resolvePocketName` + guards.

---

## Task 1: Types and pinned-version constants

**Files:**
- Modify: `src/types.ts` (after `SiteConfig`, ~line 230; and after `AppInfo`)
- Create: `src/lib/pocketbase-version.ts`
- Test: `src/__tests__/unit/pocketbase-version.test.ts`

**Interfaces:**
- Produces: `Pocket`, `PocketInfo` (types); `POCKETBASE_VERSION: string`, `POCKETBASE_IMAGE: string`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/unit/pocketbase-version.test.ts
import { describe, test, expect } from "bun:test"
import { POCKETBASE_VERSION, POCKETBASE_IMAGE } from "../../lib/pocketbase-version.ts"

describe("Unit: pocketbase version constants", () => {
  test("version is a semver string", () => {
    expect(POCKETBASE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
  test("image reference pins the same version", () => {
    expect(POCKETBASE_IMAGE.endsWith(`:${POCKETBASE_VERSION}`)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/pocketbase-version.test.ts`
Expected: FAIL — cannot resolve `../../lib/pocketbase-version.ts`.

- [ ] **Step 3: Create the constants module**

```typescript
// src/lib/pocketbase-version.ts
// Single source of truth for the pinned PocketBase version. The locally
// downloaded dev binary and the deployed container image MUST both use this
// exact version — divergence risks pb_data migration drift.
export const POCKETBASE_VERSION = "0.23.4"

// Published by CI (docker/pocketbase/Dockerfile) for the pinned version.
export const POCKETBASE_IMAGE = `ghcr.io/plosson/siteio-pocketbase:${POCKETBASE_VERSION}`
```

- [ ] **Step 4: Add the Pocket types to `src/types.ts`**

Add directly after the `SiteConfig` interface (currently ends ~line 230):

```typescript
// Pocket: PocketBase-backed site (third primitive, alongside site and app).
// Stored server-side, one container per pocket. Code is mounted read-only;
// pb_data lives on a persistent volume and is never rolled back.
export interface Pocket {
  name: string
  domains: string[]
  pocketbaseVersion: string
  status: ContainerStatus
  size: number
  version?: number
  deployedAt?: string
  deployedBy?: string
  createdAt: string
  updatedAt: string
  // Auto-generated on first deploy; surfaced via `siteio pocket admin`.
  superuserEmail?: string
  superuserPassword?: string
  // Optional Google social login (off unless both set).
  google?: { clientId: string; clientSecret: string }
}

// Pocket info returned to clients (secrets stripped).
export interface PocketInfo {
  name: string
  url: string
  adminUrl: string
  domains: string[]
  status: ContainerStatus
  pocketbaseVersion: string
  size: number
  version?: number
  deployedAt?: string
  createdAt: string
  tls?: TlsStatus
}
```

Then extend `SiteConfig` (add two fields):

```typescript
export interface SiteConfig {
  site?: string   // for static sites
  app?: string    // for container apps
  pocket?: string // for pocketbase-backed sites
  domain: string
  version?: number // last deployed version (for optimistic concurrency)
  pocketbaseVersion?: string // pinned PocketBase version for this project
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/__tests__/unit/pocketbase-version.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pocketbase-version.ts src/types.ts src/__tests__/unit/pocketbase-version.test.ts
git commit -m "feat(pocket): add Pocket types and pinned PocketBase version constants"
```

---

## Task 2: Pinned-binary manager (download + cache)

**Files:**
- Create: `src/lib/pocketbase-binary.ts`
- Test: `src/__tests__/unit/pocketbase-binary.test.ts`

**Interfaces:**
- Consumes: `POCKETBASE_VERSION` (Task 1).
- Produces:
  - `pocketbaseAssetName(version: string, plat?: NodeJS.Platform, architecture?: string): string`
  - `pocketbaseDownloadUrl(version: string, plat?: NodeJS.Platform, architecture?: string): string`
  - `pocketbaseCachePath(version: string, plat?: NodeJS.Platform): string`
  - `ensurePocketbaseBinary(version?: string): Promise<string>` (returns absolute path to the executable)

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/unit/pocketbase-binary.test.ts
import { describe, test, expect } from "bun:test"
import {
  pocketbaseAssetName,
  pocketbaseDownloadUrl,
  pocketbaseCachePath,
} from "../../lib/pocketbase-binary.ts"

describe("Unit: pocketbase binary resolution", () => {
  test("asset name maps macOS arm64", () => {
    expect(pocketbaseAssetName("0.23.4", "darwin", "arm64")).toBe("pocketbase_0.23.4_darwin_arm64.zip")
  })
  test("asset name maps linux x64 to amd64", () => {
    expect(pocketbaseAssetName("0.23.4", "linux", "x64")).toBe("pocketbase_0.23.4_linux_amd64.zip")
  })
  test("asset name maps windows", () => {
    expect(pocketbaseAssetName("0.23.4", "win32", "x64")).toBe("pocketbase_0.23.4_windows_amd64.zip")
  })
  test("download url points at the pinned github release", () => {
    expect(pocketbaseDownloadUrl("0.23.4", "linux", "arm64")).toBe(
      "https://github.com/pocketbase/pocketbase/releases/download/v0.23.4/pocketbase_0.23.4_linux_arm64.zip"
    )
  })
  test("cache path is versioned and uses .exe on windows", () => {
    expect(pocketbaseCachePath("0.23.4", "win32").endsWith("pocketbase-0.23.4/pocketbase.exe")).toBe(true)
    expect(pocketbaseCachePath("0.23.4", "linux").endsWith("pocketbase-0.23.4/pocketbase")).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/pocketbase-binary.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the binary manager**

```typescript
// src/lib/pocketbase-binary.ts
import { existsSync, mkdirSync, chmodSync } from "fs"
import { join, dirname } from "path"
import { homedir, platform as osPlatform, arch as osArch } from "os"
import { unzipSync } from "fflate"
import { SiteioError } from "../utils/errors.ts"
import { POCKETBASE_VERSION } from "./pocketbase-version.ts"

function osToken(plat: NodeJS.Platform): string {
  if (plat === "darwin") return "darwin"
  if (plat === "win32") return "windows"
  return "linux"
}

function archToken(architecture: string): string {
  return architecture === "arm64" ? "arm64" : "amd64"
}

export function pocketbaseAssetName(
  version: string,
  plat: NodeJS.Platform = osPlatform(),
  architecture: string = osArch()
): string {
  return `pocketbase_${version}_${osToken(plat)}_${archToken(architecture)}.zip`
}

export function pocketbaseDownloadUrl(
  version: string,
  plat: NodeJS.Platform = osPlatform(),
  architecture: string = osArch()
): string {
  return `https://github.com/pocketbase/pocketbase/releases/download/v${version}/${pocketbaseAssetName(version, plat, architecture)}`
}

export function pocketbaseCachePath(version: string, plat: NodeJS.Platform = osPlatform()): string {
  const exe = plat === "win32" ? "pocketbase.exe" : "pocketbase"
  return join(homedir(), ".siteio", "bin", `pocketbase-${version}`, exe)
}

// Ensure the pinned PocketBase binary is present locally, downloading it once.
// Returns the absolute path to the executable.
export async function ensurePocketbaseBinary(version: string = POCKETBASE_VERSION): Promise<string> {
  const dest = pocketbaseCachePath(version)
  if (existsSync(dest)) return dest

  const url = pocketbaseDownloadUrl(version)
  const res = await fetch(url, { headers: { "User-Agent": "siteio" } })
  if (!res.ok) {
    throw new SiteioError(`Failed to download PocketBase ${version} (${res.status}) from ${url}`)
  }

  const zip = new Uint8Array(await res.arrayBuffer())
  const files = unzipSync(zip)
  const exeName = osPlatform() === "win32" ? "pocketbase.exe" : "pocketbase"
  const bin = files[exeName]
  if (!bin) {
    throw new SiteioError(`PocketBase archive did not contain '${exeName}' (found: ${Object.keys(files).join(", ")})`)
  }

  mkdirSync(dirname(dest), { recursive: true })
  await Bun.write(dest, bin)
  chmodSync(dest, 0o755)
  return dest
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/unit/pocketbase-binary.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pocketbase-binary.ts src/__tests__/unit/pocketbase-binary.test.ts
git commit -m "feat(pocket): add pinned PocketBase binary download/cache manager"
```

---

## Task 3: Local dev runner (`pocketbase serve` args + spawn)

**Files:**
- Create: `src/lib/pocketbase-dev.ts`
- Test: `src/__tests__/unit/pocketbase-dev.test.ts`

**Interfaces:**
- Consumes: `ensurePocketbaseBinary` (Task 2).
- Produces:
  - `buildDevArgs(a: { publicDir: string; migrationsDir: string; hooksDir: string; dataDir: string; http: string }): string[]`
  - `resolveDevPaths(folder: string): { publicDir: string; migrationsDir: string; hooksDir: string; dataDir: string }`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/unit/pocketbase-dev.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/pocketbase-dev.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the runner helpers**

```typescript
// src/lib/pocketbase-dev.ts
import { join } from "path"
import { ensurePocketbaseBinary } from "./pocketbase-binary.ts"

export interface DevPaths {
  publicDir: string
  migrationsDir: string
  hooksDir: string
  dataDir: string
}

// The folder root is the web root (parity with production, where the same
// files are served under /public). Backend plumbing lives under .siteio/.
export function resolveDevPaths(folder: string): DevPaths {
  return {
    publicDir: folder,
    migrationsDir: join(folder, ".siteio", "pb_migrations"),
    hooksDir: join(folder, ".siteio", "pb_hooks"),
    dataDir: join(folder, ".siteio", "pb_data"),
  }
}

export function buildDevArgs(a: DevPaths & { http: string }): string[] {
  return [
    "serve",
    `--http=${a.http}`,
    `--dir=${a.dataDir}`,
    `--publicDir=${a.publicDir}`,
    `--migrationsDir=${a.migrationsDir}`,
    `--hooksDir=${a.hooksDir}`,
  ]
}

// Ensure the binary, then spawn `pocketbase serve` inheriting stdio so the
// user (or the driving LLM) sees the local URL and logs. Resolves with the
// process exit code when the server stops.
export async function runPocketbaseDev(folder: string, http: string, version?: string): Promise<number> {
  const bin = await ensurePocketbaseBinary(version)
  const paths = resolveDevPaths(folder)
  const proc = Bun.spawn([bin, ...buildDevArgs({ ...paths, http })], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })
  return await proc.exited
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/unit/pocketbase-dev.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pocketbase-dev.ts src/__tests__/unit/pocketbase-dev.test.ts
git commit -m "feat(pocket): add local PocketBase dev runner"
```

---

## Task 4: Scaffold writer (`pocket init`)

**Files:**
- Create: `src/lib/pocket-scaffold.ts`
- Test: `src/__tests__/unit/pocket-scaffold.test.ts`

**Interfaces:**
- Consumes: `POCKETBASE_VERSION` (Task 1), `saveProjectConfig` (existing).
- Produces: `scaffoldPocket(dir: string): { created: string[] }` — writes starter files idempotently, never overwriting an existing web root file.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/unit/pocket-scaffold.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { scaffoldPocket } from "../../lib/pocket-scaffold.ts"

describe("Unit: scaffoldPocket", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "siteio-pocket-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  test("creates the .siteio plumbing and a starter index.html", () => {
    scaffoldPocket(dir)
    expect(existsSync(join(dir, "index.html"))).toBe(true)
    expect(existsSync(join(dir, ".siteio", "pb_migrations"))).toBe(true)
    expect(existsSync(join(dir, ".siteio", "pb_hooks"))).toBe(true)
  })

  test("gitignores the local pb_data sandbox", () => {
    scaffoldPocket(dir)
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8")
    expect(gitignore).toContain(".siteio/pb_data/")
  })

  test("does not overwrite an existing index.html", () => {
    writeFileSync(join(dir, "index.html"), "<p>mine</p>")
    scaffoldPocket(dir)
    expect(readFileSync(join(dir, "index.html"), "utf-8")).toBe("<p>mine</p>")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/pocket-scaffold.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the scaffold writer**

```typescript
// src/lib/pocket-scaffold.ts
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "fs"
import { join } from "path"

const STARTER_INDEX = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>My Pocket</title>
  <script src="https://cdn.jsdelivr.net/npm/pocketbase@0.23.0/dist/pocketbase.umd.js"></script>
</head>
<body>
  <h1>It works</h1>
  <p>Your PocketBase backend is available at <code>/api</code>.</p>
  <script>
    // The SDK talks to the same origin that serves this page.
    const pb = new PocketBase(window.location.origin)
    console.log("PocketBase health:", pb.health.check ? "sdk ready" : "sdk missing")
  </script>
</body>
</html>
`

// A starter migration that defines an example "notes" collection so the LLM
// has a working template to copy. PocketBase applies pb_migrations on boot.
const STARTER_MIGRATION = `/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = new Collection({
    type: "base",
    name: "notes",
    fields: [
      { name: "title", type: "text", required: true },
      { name: "body", type: "text" },
    ],
  })
  app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("notes")
  app.delete(collection)
})
`

function ensureGitignoreEntry(dir: string, entry: string): void {
  const path = join(dir, ".gitignore")
  if (!existsSync(path)) {
    writeFileSync(path, entry + "\n")
    return
  }
  const current = readFileSync(path, "utf-8")
  if (!current.split(/\r?\n/).includes(entry)) {
    appendFileSync(path, (current.endsWith("\n") ? "" : "\n") + entry + "\n")
  }
}

export function scaffoldPocket(dir: string): { created: string[] } {
  const created: string[] = []
  const write = (rel: string, content: string) => {
    const full = join(dir, rel)
    if (existsSync(full)) return
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, content)
    created.push(rel)
  }

  mkdirSync(join(dir, ".siteio", "pb_migrations"), { recursive: true })
  mkdirSync(join(dir, ".siteio", "pb_hooks"), { recursive: true })

  write("index.html", STARTER_INDEX)
  write(join(".siteio", "pb_migrations", "1700000000_init.js"), STARTER_MIGRATION)
  write(join(".siteio", "pb_hooks", ".gitkeep"), "")

  ensureGitignoreEntry(dir, ".siteio/pb_data/")

  return { created }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/unit/pocket-scaffold.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pocket-scaffold.ts src/__tests__/unit/pocket-scaffold.test.ts
git commit -m "feat(pocket): add pocket init scaffold writer"
```

---

## Task 5: `PocketStorage` (server-side model + code extract + volume)

**Files:**
- Create: `src/lib/agent/pocket-storage.ts`
- Test: `src/__tests__/unit/pocket-storage.test.ts`

**Interfaces:**
- Consumes: `Pocket`, `PocketInfo` (Task 1).
- Produces `PocketStorage` class:
  - `constructor(dataDir: string)`
  - `create(data: Omit<Pocket, "createdAt" | "updatedAt">): Pocket`
  - `get(name: string): Pocket | null`
  - `update(name: string, updates: Partial<Omit<Pocket, "name" | "createdAt">>): Pocket | null`
  - `delete(name: string): boolean`
  - `exists(name: string): boolean`
  - `list(): Pocket[]`
  - `getCodePath(name: string): string`
  - `getDataPath(name: string): string`
  - `extractCode(name: string, zipData: Uint8Array): Promise<{ size: number; version: number }>`
  - `writeGoogleHook(name: string): void`
  - `toInfo(pocket: Pocket, domain: string): PocketInfo`

**Directory layout under `dataDir`:** `pockets/<name>.json` (metadata), `pocket-code/<name>/` (extracted code, read-only mount source), `pocket-data/<name>/` (pb_data volume), `pocket-history/<name>/v<N>` (code history, cap 10).

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/unit/pocket-storage.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { PocketStorage } from "../../lib/agent/pocket-storage.ts"
import type { Pocket } from "../../types.ts"

describe("Unit: PocketStorage", () => {
  let dir: string
  let storage: PocketStorage
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "siteio-ps-"))
    storage = new PocketStorage(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const base = (name: string): Omit<Pocket, "createdAt" | "updatedAt"> => ({
    name,
    domains: [`${name}.example.com`],
    pocketbaseVersion: "0.23.4",
    status: "pending",
    size: 0,
  })

  test("creates and reads a pocket", () => {
    storage.create(base("blog"))
    const p = storage.get("blog")
    expect(p).not.toBeNull()
    expect(p!.pocketbaseVersion).toBe("0.23.4")
    expect(p!.createdAt).toBeDefined()
  })

  test("rejects reserved and invalid names", () => {
    expect(() => storage.create(base("api"))).toThrow()
    expect(() => storage.create(base("Bad Name"))).toThrow()
  })

  test("extractCode writes files and bumps version", async () => {
    storage.create(base("blog"))
    const zip = zipSync({ "public/index.html": new TextEncoder().encode("<h1>hi</h1>") })
    const first = await storage.extractCode("blog", zip)
    expect(first.version).toBe(1)
    expect(first.size).toBeGreaterThan(0)
    expect(existsSync(join(storage.getCodePath("blog"), "public", "index.html"))).toBe(true)

    const second = await storage.extractCode("blog", zip)
    expect(second.version).toBe(2)
  })

  test("delete removes metadata, code and data", async () => {
    storage.create(base("blog"))
    const zip = zipSync({ "public/index.html": new TextEncoder().encode("x") })
    await storage.extractCode("blog", zip)
    expect(storage.delete("blog")).toBe(true)
    expect(storage.get("blog")).toBeNull()
    expect(existsSync(storage.getCodePath("blog"))).toBe(false)
  })

  test("toInfo strips secrets and exposes admin url", () => {
    const p = storage.create({ ...base("blog"), superuserEmail: "a@b.co", superuserPassword: "secret" })
    const info = storage.toInfo(p, "example.com")
    expect(info.url).toBe("https://blog.example.com")
    expect(info.adminUrl).toBe("https://blog.example.com/_/")
    expect((info as unknown as { superuserPassword?: string }).superuserPassword).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/pocket-storage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `PocketStorage`**

```typescript
// src/lib/agent/pocket-storage.ts
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, cpSync,
} from "fs"
import { join } from "path"
import { unzipSync } from "fflate"
import type { Pocket, PocketInfo } from "../../types.ts"
import { ValidationError } from "../../utils/errors.ts"

const MAX_HISTORY_VERSIONS = 10

export class PocketStorage {
  private metaDir: string
  private codeDir: string
  private dataDir: string
  private historyDir: string

  constructor(dataDir: string) {
    this.metaDir = join(dataDir, "pockets")
    this.codeDir = join(dataDir, "pocket-code")
    this.dataDir = join(dataDir, "pocket-data")
    this.historyDir = join(dataDir, "pocket-history")
    for (const d of [this.metaDir, this.codeDir, this.dataDir, this.historyDir]) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o755 })
    }
  }

  private validateName(name: string): void {
    if (!name) throw new ValidationError("Pocket name cannot be empty")
    if (!/^[a-z0-9-]+$/.test(name)) {
      throw new ValidationError("Pocket name must contain only lowercase letters, numbers, and hyphens")
    }
    if (name === "api") throw new ValidationError("'api' is a reserved name")
  }

  private metaPath(name: string): string { return join(this.metaDir, `${name}.json`) }
  getCodePath(name: string): string { return join(this.codeDir, name) }
  getDataPath(name: string): string { return join(this.dataDir, name) }
  private historyPath(name: string): string { return join(this.historyDir, name) }

  create(data: Omit<Pocket, "createdAt" | "updatedAt">): Pocket {
    this.validateName(data.name)
    if (this.exists(data.name)) throw new ValidationError(`Pocket '${data.name}' already exists`)
    const now = new Date().toISOString()
    const pocket: Pocket = { ...data, createdAt: now, updatedAt: now }
    writeFileSync(this.metaPath(pocket.name), JSON.stringify(pocket, null, 2))
    return pocket
  }

  get(name: string): Pocket | null {
    const p = this.metaPath(name)
    if (!existsSync(p)) return null
    try { return JSON.parse(readFileSync(p, "utf-8")) as Pocket } catch { return null }
  }

  update(name: string, updates: Partial<Omit<Pocket, "name" | "createdAt">>): Pocket | null {
    const pocket = this.get(name)
    if (!pocket) return null
    const updated: Pocket = {
      ...pocket, ...updates,
      name: pocket.name, createdAt: pocket.createdAt, updatedAt: new Date().toISOString(),
    }
    writeFileSync(this.metaPath(name), JSON.stringify(updated, null, 2))
    return updated
  }

  exists(name: string): boolean { return existsSync(this.metaPath(name)) }

  list(): Pocket[] {
    if (!existsSync(this.metaDir)) return []
    return readdirSync(this.metaDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.metaDir, f), "utf-8")) as Pocket)
      .sort((a, b) => (b.deployedAt || "").localeCompare(a.deployedAt || ""))
  }

  delete(name: string): boolean {
    let deleted = false
    for (const p of [this.metaPath(name), this.getCodePath(name), this.getDataPath(name), this.historyPath(name)]) {
      if (existsSync(p)) { rmSync(p, { recursive: true }); deleted = true }
    }
    return deleted
  }

  private nextVersion(name: string): number {
    const h = this.historyPath(name)
    if (!existsSync(h)) return 1
    const versions = readdirSync(h)
      .filter((f) => f.startsWith("v") && !f.endsWith(".json"))
      .map((f) => parseInt(f.slice(1), 10))
      .filter((n) => !isNaN(n))
    return versions.length > 0 ? Math.max(...versions) + 1 : 1
  }

  private archiveCode(name: string): void {
    const codePath = this.getCodePath(name)
    if (!existsSync(codePath)) return
    const h = this.historyPath(name)
    if (!existsSync(h)) mkdirSync(h, { recursive: true })
    const version = this.nextVersion(name)
    cpSync(codePath, join(h, `v${version}`), { recursive: true })
    // Prune
    const versions = readdirSync(h)
      .filter((f) => f.startsWith("v") && !f.endsWith(".json"))
      .map((f) => parseInt(f.slice(1), 10)).filter((n) => !isNaN(n)).sort((a, b) => a - b)
    while (versions.length > MAX_HISTORY_VERSIONS) {
      const old = versions.shift()!
      const p = join(h, `v${old}`)
      if (existsSync(p)) rmSync(p, { recursive: true })
    }
  }

  // Extract an uploaded code zip (public/**, pb_migrations/**, pb_hooks/**) to
  // the read-only mount source. NEVER touches the pb_data volume.
  async extractCode(name: string, zipData: Uint8Array): Promise<{ size: number; version: number }> {
    const codePath = this.getCodePath(name)
    if (existsSync(codePath)) {
      this.archiveCode(name)
      rmSync(codePath, { recursive: true })
    }
    mkdirSync(codePath, { recursive: true, mode: 0o755 })

    let size = 0
    const unzipped = unzipSync(zipData)
    for (const [filename, data] of Object.entries(unzipped)) {
      if (filename.endsWith("/")) continue
      const filePath = join(codePath, filename)
      mkdirSync(join(filePath, ".."), { recursive: true, mode: 0o755 })
      await Bun.write(filePath, data, { mode: 0o644 })
      size += data.length
    }
    // Ensure PocketBase's expected subdirs exist even if the upload omitted them.
    for (const sub of ["public", "pb_migrations", "pb_hooks"]) {
      const p = join(codePath, sub)
      if (!existsSync(p)) mkdirSync(p, { recursive: true, mode: 0o755 })
    }

    const version = this.nextVersion(name)
    return { size, version }
  }

  // Inject a system hook that enables Google OAuth2 from env vars when both are
  // present. Written into the mounted pb_hooks dir so PocketBase loads it.
  // Targeted at the pinned PocketBase version; verified manually (see plan §Task 8).
  writeGoogleHook(name: string): void {
    const hook = `onBootstrap((e) => {
  e.next()
  const id = $os.getenv("POCKET_GOOGLE_CLIENT_ID")
  const secret = $os.getenv("POCKET_GOOGLE_CLIENT_SECRET")
  if (!id || !secret) return
  const s = $app.settings()
  s.googleAuth.enabled = true
  s.googleAuth.clientId = id
  s.googleAuth.clientSecret = secret
  $app.save(s)
})
`
    const dir = join(this.getCodePath(name), "pb_hooks")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 })
    writeFileSync(join(dir, "_siteio_google.pb.js"), hook, { mode: 0o644 })
  }

  toInfo(pocket: Pocket, domain: string): PocketInfo {
    const primary = pocket.domains[0] || `${pocket.name}.${domain}`
    return {
      name: pocket.name,
      url: `https://${primary}`,
      adminUrl: `https://${primary}/_/`,
      domains: pocket.domains,
      status: pocket.status,
      pocketbaseVersion: pocket.pocketbaseVersion,
      size: pocket.size,
      version: pocket.version,
      deployedAt: pocket.deployedAt,
      createdAt: pocket.createdAt,
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/unit/pocket-storage.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/pocket-storage.ts src/__tests__/unit/pocket-storage.test.ts
git commit -m "feat(pocket): add PocketStorage (metadata, code extract, volume, history)"
```

---

## Task 6: Shipped `siteio-pocketbase` image

**Files:**
- Create: `docker/pocketbase/Dockerfile`
- Create: `docker/pocketbase/entrypoint.sh`

**Interfaces:**
- Produces the image referenced by `POCKETBASE_IMAGE` (Task 1). CI publishes it; the agent `pull`s it at deploy time. This task has no unit test (it is a container image); it is validated by the API test in Task 8 (which uses `FakeRuntime` and only asserts siteio pulls/runs the pinned image ref) and by a manual smoke test at the end.

- [ ] **Step 1: Write the entrypoint**

```sh
# docker/pocketbase/entrypoint.sh
#!/bin/sh
set -e

# Bootstrap/refresh the superuser from env (idempotent). Creds are generated by
# the agent on first deploy and surfaced via `siteio pocket admin`.
if [ -n "$POCKET_SUPERUSER_EMAIL" ] && [ -n "$POCKET_SUPERUSER_PASSWORD" ]; then
  pocketbase superuser upsert "$POCKET_SUPERUSER_EMAIL" "$POCKET_SUPERUSER_PASSWORD" --dir=/pb-data || true
fi

exec pocketbase serve \
  --http=0.0.0.0:8090 \
  --dir=/pb-data \
  --publicDir=/pb-code/public \
  --migrationsDir=/pb-code/pb_migrations \
  --hooksDir=/pb-code/pb_hooks
```

- [ ] **Step 2: Write the Dockerfile**

```dockerfile
# docker/pocketbase/Dockerfile
# Build arg is wired to POCKETBASE_VERSION by CI so the image tag and the binary
# stay in lockstep with src/lib/pocketbase-version.ts.
FROM alpine:3.20

ARG POCKETBASE_VERSION
ARG TARGETARCH=amd64

RUN apk add --no-cache ca-certificates unzip wget \
  && wget -O /tmp/pb.zip \
     "https://github.com/pocketbase/pocketbase/releases/download/v${POCKETBASE_VERSION}/pocketbase_${POCKETBASE_VERSION}_linux_${TARGETARCH}.zip" \
  && unzip /tmp/pb.zip -d /usr/local/bin/ \
  && rm /tmp/pb.zip \
  && chmod +x /usr/local/bin/pocketbase

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# /pb-code is the read-only code mount; /pb-data is the persistent volume.
VOLUME ["/pb-data"]
EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

- [ ] **Step 3: Verify the image builds locally (manual)**

Run: `docker build --build-arg POCKETBASE_VERSION=0.23.4 -t siteio-pocketbase:local docker/pocketbase`
Expected: image builds; `docker run --rm siteio-pocketbase:local pocketbase --version` prints `0.23.4`.

> Note: publishing to `ghcr.io/plosson/siteio-pocketbase:<version>` is a CI/release concern. Add a GitHub Actions job that builds this image on version bump and pushes the tag. That CI wiring is out of scope for the automated tests here; track it as a release checklist item.

- [ ] **Step 4: Commit**

```bash
git add docker/pocketbase/Dockerfile docker/pocketbase/entrypoint.sh
git commit -m "feat(pocket): add shipped siteio-pocketbase image"
```

---

## Task 7: Agent routes + deploy handler

**Files:**
- Modify: `src/lib/agent/server.ts` (import + field + constructor ~lines 1-66; routing table ~lines 252-305; new handler methods near the app handlers)
- Test: `src/__tests__/api/pockets.test.ts`

**Interfaces:**
- Consumes: `PocketStorage` (Task 5), `POCKETBASE_IMAGE` (Task 1), `DockerManager`/`Runtime` + `buildTraefikLabels` (existing).
- Produces agent endpoints:
  - `GET /pockets` → `PocketInfo[]`
  - `GET /pockets/:name` → `PocketInfo`
  - `DELETE /pockets/:name`
  - `POST /pockets/:name` (zip body) → deploy (create-or-update) → `PocketInfo`
  - `GET /pockets/:name/logs` → `ContainerLogs`
  - `GET /pockets/:name/admin` → `{ email, password, adminUrl }`

- [ ] **Step 1: Write the failing API test**

```typescript
// src/__tests__/api/pockets.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import { POCKETBASE_IMAGE } from "../../lib/pocketbase-version.ts"
import type { AgentConfig } from "../../types.ts"

function makeServer(dataDir: string, runtime: FakeRuntime): AgentServer {
  const config: AgentConfig = {
    apiKey: "test-key", dataDir, domain: "example.com",
    maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
  }
  return new AgentServer(config, runtime)
}

const H = { "X-API-Key": "test-key", "Content-Type": "application/zip" }

describe("API: pockets", () => {
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

  test("POST /pockets/:name deploys a new pocket using the pinned image", async () => {
    const res = await server.handleRequestForTest(
      new Request("http://x/pockets/blog", { method: "POST", headers: H, body: zip() })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.url).toBe("https://blog.example.com")
    expect(body.data.status).toBe("running")

    const runCall = runtime.calls.find((c) => c.method === "run")
    expect(runCall).toBeDefined()
    const pullCall = runtime.calls.find((c) => c.method === "pull")
    expect(pullCall!.args[0]).toBe(POCKETBASE_IMAGE)
  })

  test("GET /pockets lists deployed pockets", async () => {
    await server.handleRequestForTest(new Request("http://x/pockets/blog", { method: "POST", headers: H, body: zip() }))
    const res = await server.handleRequestForTest(new Request("http://x/pockets", { method: "GET", headers: { "X-API-Key": "test-key" } }))
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].name).toBe("blog")
  })

  test("GET /pockets/:name/admin returns generated superuser credentials", async () => {
    await server.handleRequestForTest(new Request("http://x/pockets/blog", { method: "POST", headers: H, body: zip() }))
    const res = await server.handleRequestForTest(new Request("http://x/pockets/blog/admin", { method: "GET", headers: { "X-API-Key": "test-key" } }))
    const body = await res.json()
    expect(body.data.email).toContain("@")
    expect(body.data.password.length).toBeGreaterThan(8)
    expect(body.data.adminUrl).toBe("https://blog.example.com/_/")
  })

  test("DELETE /pockets/:name removes it", async () => {
    await server.handleRequestForTest(new Request("http://x/pockets/blog", { method: "POST", headers: H, body: zip() }))
    const del = await server.handleRequestForTest(new Request("http://x/pockets/blog", { method: "DELETE", headers: { "X-API-Key": "test-key" } }))
    expect(del.status).toBe(200)
    const list = await server.handleRequestForTest(new Request("http://x/pockets", { method: "GET", headers: { "X-API-Key": "test-key" } }))
    const body = await list.json()
    expect(body.data).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Add a test seam for `handleRequest`**

`handleRequest` is currently private. Add a thin public passthrough used only by tests (mirrors how e2e tests exercise the server). Near the other public methods in `server.ts`:

```typescript
  // Test seam: exercise the router directly without binding a socket.
  handleRequestForTest(req: Request): Promise<Response> {
    return this.handleRequest(req)
  }
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/__tests__/api/pockets.test.ts`
Expected: FAIL — `handleRequestForTest` returns 404 for `/pockets/...` (no routes yet); pull assertion fails.

- [ ] **Step 4: Wire `PocketStorage` into the server**

In `src/lib/agent/server.ts`, add the import (near the other agent imports at top):

```typescript
import { PocketStorage } from "./pocket-storage.ts"
import { POCKETBASE_IMAGE } from "../pocketbase-version.ts"
```

Add the field (next to `private appStorage: AppStorage`):

```typescript
  private pocketStorage: PocketStorage
```

Initialize it in the constructor (next to `this.appStorage = new AppStorage(config.dataDir)`):

```typescript
    this.pocketStorage = new PocketStorage(config.dataDir)
```

- [ ] **Step 5: Add routes to `handleRequest`**

Insert immediately before the final `return this.error("Not found", 404)` (currently ~line 304):

```typescript
    // GET /pockets - list all pockets
    if (path === "/pockets" && req.method === "GET") {
      return this.handleListPockets()
    }

    // POST /pockets/:name - deploy (create-or-update) a pocket
    const pocketDeployMatch = path.match(/^\/pockets\/([a-z0-9-]+)$/)
    if (pocketDeployMatch) {
      const pocketName = pocketDeployMatch[1]!
      if (req.method === "POST") return this.handleDeployPocket(pocketName, req)
      if (req.method === "GET") return this.handleGetPocket(pocketName)
      if (req.method === "DELETE") return this.handleDeletePocket(pocketName)
    }

    // GET /pockets/:name/logs
    const pocketLogsMatch = path.match(/^\/pockets\/([a-z0-9-]+)\/logs$/)
    if (pocketLogsMatch && req.method === "GET") {
      return this.handleGetPocketLogs(pocketLogsMatch[1]!, url)
    }

    // GET /pockets/:name/admin - reveal superuser credentials
    const pocketAdminMatch = path.match(/^\/pockets\/([a-z0-9-]+)\/admin$/)
    if (pocketAdminMatch && req.method === "GET") {
      return this.handleGetPocketAdmin(pocketAdminMatch[1]!)
    }
```

- [ ] **Step 6: Add the handler methods**

Add near the app handlers (e.g. after `handleDeployApp`). Note `checkAuth` is already enforced globally for non-public routes exactly as it is for `/apps`; follow the surrounding code — if app handlers call `this.checkAuth(req)` inline, mirror that. (Apps rely on the shared auth gate in `handleRequest`; do the same, no extra check needed here.)

```typescript
  private async handleListPockets(): Promise<Response> {
    const pockets = this.pocketStorage.list()
    return this.json(pockets.map((p) => this.pocketStorage.toInfo(p, this.config.domain)))
  }

  private async handleGetPocket(name: string): Promise<Response> {
    const pocket = this.pocketStorage.get(name)
    if (!pocket) return this.error("Pocket not found", 404)
    return this.json(this.pocketStorage.toInfo(pocket, this.config.domain))
  }

  private async handleDeletePocket(name: string): Promise<Response> {
    const pocket = this.pocketStorage.get(name)
    if (!pocket) return this.error("Pocket not found", 404)
    try {
      if (this.docker.isAvailable() && this.docker.containerExists(name)) {
        await this.docker.remove(name)
      }
    } catch {
      // best effort — proceed to remove metadata/code even if the container is gone
    }
    this.pocketStorage.delete(name)
    return this.json({ deleted: true })
  }

  private async handleGetPocketAdmin(name: string): Promise<Response> {
    const pocket = this.pocketStorage.get(name)
    if (!pocket) return this.error("Pocket not found", 404)
    const primary = pocket.domains[0] || `${name}.${this.config.domain}`
    return this.json({
      email: pocket.superuserEmail,
      password: pocket.superuserPassword,
      adminUrl: `https://${primary}/_/`,
    })
  }

  private async handleGetPocketLogs(name: string, url: URL): Promise<Response> {
    const pocket = this.pocketStorage.get(name)
    if (!pocket) return this.error("Pocket not found", 404)
    const tail = parseInt(url.searchParams.get("tail") || "100", 10)
    try {
      const logs = await this.docker.logs(name, tail)
      return this.json({ name, logs, lines: tail } as ContainerLogs)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to get logs"
      return this.error(message, 500)
    }
  }

  private async handleDeployPocket(name: string, req: Request): Promise<Response> {
    // Validate upload
    const contentType = req.headers.get("Content-Type") || ""
    if (!contentType.includes("application/zip")) {
      return this.error("Expected application/zip body", 400)
    }
    const zipData = new Uint8Array(await req.arrayBuffer())
    if (zipData.length === 0) return this.error("Empty upload", 400)
    if (zipData.length > this.config.maxUploadSize) {
      return this.error("Upload too large", 413)
    }

    const deployedBy = req.headers.get("X-Deployed-By") || undefined
    const version = req.headers.get("X-Pocket-Version") || POCKETBASE_VERSION
    const googleId = req.headers.get("X-Pocket-Google-Client-Id") || undefined
    const googleSecret = req.headers.get("X-Pocket-Google-Client-Secret") || undefined

    // Create metadata on first deploy (generates superuser creds).
    let pocket = this.pocketStorage.get(name)
    if (!pocket) {
      pocket = this.pocketStorage.create({
        name,
        domains: [`${name}.${this.config.domain}`],
        pocketbaseVersion: version,
        status: "pending",
        size: 0,
        superuserEmail: `admin@${name}.${this.config.domain}`,
        superuserPassword: crypto.randomUUID().replace(/-/g, ""),
        google: googleId && googleSecret ? { clientId: googleId, clientSecret: googleSecret } : undefined,
      })
    } else if (googleId && googleSecret) {
      pocket = this.pocketStorage.update(name, { google: { clientId: googleId, clientSecret: googleSecret } })!
    }

    try {
      // Extract code (archives previous version); never touches pb_data.
      const { size, version: codeVersion } = await this.pocketStorage.extractCode(name, zipData)
      if (pocket.google) this.pocketStorage.writeGoogleHook(name)

      if (!this.docker.isAvailable()) return this.error("Docker is not available", 500)
      this.docker.ensureNetwork()
      await this.docker.pull(POCKETBASE_IMAGE)
      if (this.docker.containerExists(name)) await this.docker.remove(name)

      const domains = pocket.domains.length > 0 ? pocket.domains : [`${name}.${this.config.domain}`]
      const labels = this.docker.buildTraefikLabels(name, domains, 8090)

      const env: Record<string, string> = {
        POCKET_SUPERUSER_EMAIL: pocket.superuserEmail!,
        POCKET_SUPERUSER_PASSWORD: pocket.superuserPassword!,
      }
      if (pocket.google) {
        env.POCKET_GOOGLE_CLIENT_ID = pocket.google.clientId
        env.POCKET_GOOGLE_CLIENT_SECRET = pocket.google.clientSecret
      }

      const containerId = await this.docker.run({
        name,
        image: POCKETBASE_IMAGE,
        internalPort: 8090,
        env,
        volumes: [
          { name: this.pocketStorage.getCodePath(name), mountPath: "/pb-code", readonly: true },
          { name: this.pocketStorage.getDataPath(name), mountPath: "/pb-data" },
        ],
        restartPolicy: "unless-stopped",
        network: "siteio-network",
        labels,
      })

      const updated = this.pocketStorage.update(name, {
        status: "running",
        containerId,
        size,
        version: codeVersion,
        pocketbaseVersion: version,
        deployedAt: new Date().toISOString(),
        deployedBy,
      })!
      return this.json(this.pocketStorage.toInfo(updated, this.config.domain))
    } catch (err) {
      this.pocketStorage.update(name, { status: "failed" })
      const message = err instanceof Error ? err.message : "Failed to deploy pocket"
      return this.error(message, 500)
    }
  }
```

> `getDataPath(name)` is created lazily by the volume mount; ensure it exists before `run`. Add one line just before building volumes: `mkdirSync(this.pocketStorage.getDataPath(name), { recursive: true, mode: 0o755 })` (import `mkdirSync` from `fs` at top of `server.ts` if not already imported — check first).

- [ ] **Step 7: Run test to verify it passes**

Run: `bun test src/__tests__/api/pockets.test.ts && bun run typecheck`
Expected: PASS (4 tests); typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/agent/server.ts src/__tests__/api/pockets.test.ts
git commit -m "feat(pocket): add agent /pockets routes and deploy handler"
```

---

## Task 8: Client methods

**Files:**
- Modify: `src/lib/client.ts` (add after the Apps API block, before the closing brace ~line 437)
- Test: covered end-to-end by Task 7's API tests + Task 9-11 command tests. Add focused client tests here.
- Test file: `src/__tests__/unit/client-pocket.test.ts`

**Interfaces:**
- Consumes: agent routes (Task 7).
- Produces on `SiteioClient`:
  - `deployPocket(name: string, zipData: Uint8Array, opts?: { version?: string; google?: { clientId: string; clientSecret: string }; deployedBy?: string }): Promise<PocketInfo>`
  - `listPockets(): Promise<PocketInfo[]>`
  - `getPocket(name: string): Promise<PocketInfo>`
  - `deletePocket(name: string): Promise<void>`
  - `getPocketLogs(name: string, tail?: number): Promise<ContainerLogs>`
  - `getPocketAdmin(name: string): Promise<{ email: string; password: string; adminUrl: string }>`

- [ ] **Step 1: Write the failing test** (uses a stubbed `fetch`)

```typescript
// src/__tests__/unit/client-pocket.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { SiteioClient } from "../../lib/client.ts"

const realFetch = globalThis.fetch

describe("Unit: SiteioClient pocket methods", () => {
  let client: SiteioClient
  beforeEach(() => {
    client = new SiteioClient({ apiUrl: "http://agent", apiKey: "k" })
  })
  afterEach(() => { globalThis.fetch = realFetch })

  test("deployPocket POSTs the zip and returns info", async () => {
    let captured: { url: string; method?: string; headers: Record<string, string> } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, method: init.method, headers: init.headers as Record<string, string> }
      return new Response(JSON.stringify({ success: true, data: { name: "blog", url: "https://blog.example.com" } }), { status: 200 })
    }) as typeof fetch

    const info = await client.deployPocket("blog", new Uint8Array([1, 2, 3]), {
      google: { clientId: "cid", clientSecret: "sec" },
    })
    expect(info.name).toBe("blog")
    expect(captured!.url).toBe("http://agent/pockets/blog")
    expect(captured!.method).toBe("POST")
    expect(captured!.headers["Content-Type"]).toBe("application/zip")
    expect(captured!.headers["X-Pocket-Google-Client-Id"]).toBe("cid")
  })

  test("getPocketAdmin returns credentials", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: true, data: { email: "a@b.co", password: "pw", adminUrl: "https://blog.example.com/_/" } }), { status: 200 })
    ) as typeof fetch
    const admin = await client.getPocketAdmin("blog")
    expect(admin.email).toBe("a@b.co")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/client-pocket.test.ts`
Expected: FAIL — `deployPocket` is not a function.

- [ ] **Step 3: Add the client methods**

Add `PocketInfo` to the type import at the top of `client.ts`:

```typescript
import type { ApiResponse, SiteInfo, SiteOAuth, SiteVersion, Group, App, AppInfo, ContainerLogs, PocketInfo } from "../types.ts"
```

Add before the final closing brace of the class:

```typescript
  // Pockets API

  async deployPocket(
    name: string,
    zipData: Uint8Array,
    opts?: { version?: string; google?: { clientId: string; clientSecret: string }; deployedBy?: string }
  ): Promise<PocketInfo> {
    const headers: Record<string, string> = {
      "Content-Type": "application/zip",
      "Content-Length": String(zipData.length),
    }
    if (opts?.deployedBy) headers["X-Deployed-By"] = opts.deployedBy
    if (opts?.version) headers["X-Pocket-Version"] = opts.version
    if (opts?.google) {
      headers["X-Pocket-Google-Client-Id"] = opts.google.clientId
      headers["X-Pocket-Google-Client-Secret"] = opts.google.clientSecret
    }
    const response = await this.request<ApiResponse<PocketInfo>>("POST", `/pockets/${name}`, zipData, headers)
    if (!response.data) throw new ApiError("Invalid response from server")
    return response.data
  }

  async listPockets(): Promise<PocketInfo[]> {
    const response = await this.request<ApiResponse<PocketInfo[]>>("GET", "/pockets")
    return response.data || []
  }

  async getPocket(name: string): Promise<PocketInfo> {
    const response = await this.request<ApiResponse<PocketInfo>>("GET", `/pockets/${name}`)
    if (!response.data) throw new ApiError("Invalid response from server")
    return response.data
  }

  async deletePocket(name: string): Promise<void> {
    await this.request<ApiResponse<{ deleted: boolean }>>("DELETE", `/pockets/${name}`)
  }

  async getPocketLogs(name: string, tail: number = 100): Promise<ContainerLogs> {
    const response = await this.request<ApiResponse<ContainerLogs>>("GET", `/pockets/${name}/logs?tail=${tail}`)
    if (!response.data) throw new ApiError("Invalid response from server")
    return response.data
  }

  async getPocketAdmin(name: string): Promise<{ email: string; password: string; adminUrl: string }> {
    const response = await this.request<ApiResponse<{ email: string; password: string; adminUrl: string }>>("GET", `/pockets/${name}/admin`)
    if (!response.data) throw new ApiError("Invalid response from server")
    return response.data
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/unit/client-pocket.test.ts && bun run typecheck`
Expected: PASS (2 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/client.ts src/__tests__/unit/client-pocket.test.ts
git commit -m "feat(pocket): add SiteioClient pocket methods"
```

---

## Task 9: `resolvePocketName` config helper

**Files:**
- Modify: `src/utils/site-config.ts` (add helper mirroring `resolveAppName`)
- Test: `src/__tests__/unit/site-config.test.ts` (extend existing)

**Interfaces:**
- Consumes: `loadProjectConfig` (existing), `SiteConfig.pocket` (Task 1).
- Produces: `resolvePocketName(explicit: string | undefined, serverDomain: string, dir?: string): string | null`

- [ ] **Step 1: Write the failing test** (append to existing describe block)

```typescript
// add to src/__tests__/unit/site-config.test.ts
import { resolvePocketName } from "../../utils/site-config.ts"

test("resolvePocketName reads .siteio/config.json pocket field", () => {
  // (follow the file's existing pattern for writing a temp .siteio/config.json)
  // Given a config { pocket: "blog", domain: "example.com" } in tmp dir:
  expect(resolvePocketName(undefined, "example.com", tmpDir)).toBe("blog")
})

test("resolvePocketName rejects a site-configured directory", () => {
  // Given { site: "foo", domain: "example.com" }:
  expect(() => resolvePocketName(undefined, "example.com", siteDir)).toThrow()
})
```

> Match the exact temp-dir setup already used by the neighboring tests in this file (they create `.siteio/config.json` via `saveProjectConfig` or direct write). Reuse that harness rather than inventing a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/site-config.test.ts`
Expected: FAIL — `resolvePocketName` not exported.

- [ ] **Step 3: Implement the helper**

Append to `src/utils/site-config.ts`:

```typescript
/**
 * Resolve pocket name from explicit argument or .siteio/config.json.
 * Returns null if neither source provides a value.
 */
export function resolvePocketName(explicit: string | undefined, serverDomain: string, dir?: string): string | null {
  if (explicit) return explicit
  const config = loadProjectConfig(dir)
  if (config) {
    if ((config.site || config.app) && !config.pocket) {
      const other = config.site ? `site ('${config.site}')` : `app ('${config.app}')`
      throw new ValidationError(`This directory is configured as a ${other}, not a pocket.`)
    }
    if (config.pocket && config.domain === serverDomain) {
      return config.pocket
    }
  }
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/unit/site-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/site-config.ts src/__tests__/unit/site-config.test.ts
git commit -m "feat(pocket): add resolvePocketName config helper"
```

---

## Task 10: CLI commands — `init` and `dev`

**Files:**
- Create: `src/commands/pocket/init.ts`, `src/commands/pocket/dev.ts`
- Modify: `src/cli.ts` (register the `pocket` group + these two subcommands)
- Test: `src/__tests__/cli/pocket-init.test.ts`

**Interfaces:**
- Consumes: `scaffoldPocket` (Task 4), `runPocketbaseDev` (Task 3), `saveProjectConfig`/`getCurrentServer` (existing), `POCKETBASE_VERSION` (Task 1).
- Produces: `pocketInitCommand(folder: string | undefined, options: { json?: boolean }): Promise<void>`, `pocketDevCommand(folder: string | undefined, options: { port?: number }): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/cli/pocket-init.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { scaffoldPocket } from "../../lib/pocket-scaffold.ts"

// pocketInitCommand calls process.exit; test the scaffold contract it relies on
// plus that the command module imports cleanly.
describe("CLI: pocket init contract", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "siteio-init-")) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("scaffold produces a deployable layout", () => {
    scaffoldPocket(dir)
    expect(existsSync(join(dir, "index.html"))).toBe(true)
    expect(existsSync(join(dir, ".siteio", "pb_migrations"))).toBe(true)
  })

  test("init command module loads", async () => {
    const mod = await import("../../commands/pocket/init.ts")
    expect(typeof mod.pocketInitCommand).toBe("function")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/cli/pocket-init.test.ts`
Expected: FAIL — cannot import `../../commands/pocket/init.ts`.

- [ ] **Step 3: Implement `pocket init`**

```typescript
// src/commands/pocket/init.ts
import { resolve, basename } from "path"
import chalk from "chalk"
import { scaffoldPocket } from "../../lib/pocket-scaffold.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { saveProjectConfig } from "../../utils/site-config.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError } from "../../utils/errors.ts"
import { POCKETBASE_VERSION } from "../../lib/pocketbase-version.ts"

export async function pocketInitCommand(folder: string | undefined, options: { json?: boolean } = {}): Promise<void> {
  try {
    const dir = resolve(folder || ".")
    const { created } = scaffoldPocket(dir)

    // Record the project as a pocket so deploy/dev can resolve it without args.
    const server = getCurrentServer()
    saveProjectConfig({ pocket: basename(dir), domain: server?.domain || "", pocketbaseVersion: POCKETBASE_VERSION }, dir)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { created } }, null, 2))
    } else {
      console.error(formatSuccess("Pocket initialized"))
      for (const f of created) console.error(`  ${chalk.dim("created")} ${f}`)
      console.error("")
      console.error(`Run ${chalk.cyan("siteio pocket dev")} to test locally (no Docker required).`)
    }
    process.exit(0)
  } catch (err) {
    handleError(err)
  }
}
```

- [ ] **Step 4: Implement `pocket dev`**

```typescript
// src/commands/pocket/dev.ts
import { resolve } from "path"
import { existsSync } from "fs"
import chalk from "chalk"
import { runPocketbaseDev } from "../../lib/pocketbase-dev.ts"
import { loadProjectConfig } from "../../utils/site-config.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { POCKETBASE_VERSION } from "../../lib/pocketbase-version.ts"

export async function pocketDevCommand(folder: string | undefined, options: { port?: number } = {}): Promise<void> {
  try {
    const dir = resolve(folder || ".")
    if (!existsSync(dir)) throw new ValidationError(`Folder not found: ${dir}`)

    const config = loadProjectConfig(dir)
    const version = config?.pocketbaseVersion || POCKETBASE_VERSION
    const port = options.port || 8090
    const http = `127.0.0.1:${port}`

    console.error(chalk.cyan(`> Starting PocketBase ${version} at http://${http}`))
    console.error(chalk.dim("  Serving this folder + /api backend. Press Ctrl+C to stop."))

    // Prints the local URL to stdout so the driving agent can hit it.
    console.log(`http://${http}`)

    const code = await runPocketbaseDev(dir, http, version)
    process.exit(code)
  } catch (err) {
    handleError(err)
  }
}
```

- [ ] **Step 5: Register the `pocket` group in `src/cli.ts`**

After the `apps` command block, add:

```typescript
// Pocket commands (PocketBase-backed sites)
const pocket = program
  .command("pocket")
  .description("Manage PocketBase-backed sites (auth + storage + database)")

pocket
  .command("init [folder]")
  .description("Scaffold a new pocket project")
  .action(async (folder) => {
    const { pocketInitCommand } = await import("./commands/pocket/init.ts")
    await pocketInitCommand(folder, { json: program.opts().json })
  })

pocket
  .command("dev [folder]")
  .description("Run the pocket locally with PocketBase (no Docker required)")
  .option("-p, --port <port>", "Local port", parseInt, 8090)
  .action(async (folder, options) => {
    const { pocketDevCommand } = await import("./commands/pocket/dev.ts")
    await pocketDevCommand(folder, options)
  })
```

- [ ] **Step 6: Run test + typecheck**

Run: `bun test src/__tests__/cli/pocket-init.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Manual smoke test (dev runner)**

Run: `bun run src/cli.ts pocket init /tmp/mypocket && bun run src/cli.ts pocket dev /tmp/mypocket`
Expected: downloads PocketBase once, prints `http://127.0.0.1:8090`, serves the starter page; `curl -s localhost:8090/api/health` returns JSON. Ctrl+C stops it.

- [ ] **Step 8: Commit**

```bash
git add src/commands/pocket/init.ts src/commands/pocket/dev.ts src/cli.ts src/__tests__/cli/pocket-init.test.ts
git commit -m "feat(pocket): add pocket init and dev CLI commands"
```

---

## Task 11: CLI commands — `deploy`, `list`, `info`, `logs`, `rm`, `admin`

**Files:**
- Create: `src/commands/pocket/deploy.ts`, `list.ts`, `info.ts`, `logs.ts`, `rm.ts`, `admin.ts`
- Modify: `src/cli.ts` (register these subcommands)
- Test: `src/__tests__/unit/pocket-deploy-collect.test.ts`

**Interfaces:**
- Consumes: `SiteioClient` pocket methods (Task 8), `resolvePocketName` (Task 9), `loadProjectConfig`/`saveProjectConfig`/`getCurrentServer` (existing).
- Produces the command functions + a pure helper `collectPocketFiles(folder: string): Promise<Record<string, Uint8Array>>` that builds the deploy artifact (`public/**`, `pb_migrations/**`, `pb_hooks/**`) and **excludes `.siteio/pb_data`**.

- [ ] **Step 1: Write the failing test for the artifact boundary**

```typescript
// src/__tests__/unit/pocket-deploy-collect.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { collectPocketFiles } from "../../commands/pocket/deploy.ts"

describe("Unit: collectPocketFiles", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "siteio-pd-"))
    writeFileSync(join(dir, "index.html"), "<h1>hi</h1>")
    mkdirSync(join(dir, ".siteio", "pb_migrations"), { recursive: true })
    writeFileSync(join(dir, ".siteio", "pb_migrations", "1_init.js"), "// mig")
    mkdirSync(join(dir, ".siteio", "pb_hooks"), { recursive: true })
    writeFileSync(join(dir, ".siteio", "pb_hooks", "main.pb.js"), "// hook")
    mkdirSync(join(dir, ".siteio", "pb_data"), { recursive: true })
    writeFileSync(join(dir, ".siteio", "pb_data", "data.db"), "SECRET")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("maps web root to public/ and includes migrations + hooks", async () => {
    const files = await collectPocketFiles(dir)
    expect(Object.keys(files)).toContain("public/index.html")
    expect(Object.keys(files)).toContain("pb_migrations/1_init.js")
    expect(Object.keys(files)).toContain("pb_hooks/main.pb.js")
  })

  test("NEVER includes pb_data", async () => {
    const files = await collectPocketFiles(dir)
    const leaked = Object.keys(files).filter((k) => k.includes("pb_data"))
    expect(leaked).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/pocket-deploy-collect.test.ts`
Expected: FAIL — cannot import `collectPocketFiles`.

- [ ] **Step 3: Implement `pocket deploy` (with the collector)**

```typescript
// src/commands/pocket/deploy.ts
import { existsSync, readdirSync, statSync } from "fs"
import { join, resolve, basename } from "path"
import ora from "ora"
import chalk from "chalk"
import { zipSync } from "fflate"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer, getUsername } from "../../config/loader.ts"
import { loadProjectConfig, saveProjectConfig } from "../../utils/site-config.ts"
import { formatSuccess, formatBytes } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { POCKETBASE_VERSION } from "../../lib/pocketbase-version.ts"

// Recursively collect files from `dir` into the zip map under `prefix`.
async function addTree(dir: string, prefix: string, out: Record<string, Uint8Array>): Promise<void> {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const rel = prefix ? `${prefix}/${entry}` : entry
    if (statSync(full).isDirectory()) {
      await addTree(full, rel, out)
    } else {
      out[rel] = await Bun.file(full).bytes()
    }
  }
}

// Build the deploy artifact: web root -> public/, plus pb_migrations and
// pb_hooks. NEVER includes .siteio/pb_data or the .siteio dir wholesale.
export async function collectPocketFiles(folder: string): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {}
  // Web root = folder contents minus the .siteio plumbing dir.
  for (const entry of readdirSync(folder)) {
    if (entry === ".siteio") continue
    const full = join(folder, entry)
    if (statSync(full).isDirectory()) {
      await addTree(full, `public/${entry}`, out)
    } else {
      out[`public/${entry}`] = await Bun.file(full).bytes()
    }
  }
  await addTree(join(folder, ".siteio", "pb_migrations"), "pb_migrations", out)
  await addTree(join(folder, ".siteio", "pb_hooks"), "pb_hooks", out)
  return out
}

export interface PocketDeployOptions {
  googleClientId?: string
  googleClientSecret?: string
  json?: boolean
}

export async function pocketDeployCommand(folder: string | undefined, options: PocketDeployOptions = {}): Promise<void> {
  const spinner = ora()
  try {
    const server = getCurrentServer()
    if (!server) throw new ValidationError("Not logged in. Run 'siteio login' first.")

    const folderPath = resolve(folder || ".")
    if (!existsSync(folderPath)) throw new ValidationError(`Folder not found: ${folderPath}`)

    const config = loadProjectConfig(folderPath)
    if ((config?.site || config?.app) && !config?.pocket) {
      throw new ValidationError("This directory is a site or app, not a pocket.")
    }
    const name = config?.pocket || basename(folderPath)
    if (!/^[a-z0-9-]+$/.test(name)) {
      throw new ValidationError("Pocket name must contain only lowercase letters, numbers, and hyphens")
    }

    if ((options.googleClientId && !options.googleClientSecret) || (!options.googleClientId && options.googleClientSecret)) {
      throw new ValidationError("Google login requires BOTH --google-client-id and --google-client-secret")
    }

    console.error(chalk.cyan(`> Deploying pocket ${name}`))
    saveProjectConfig({ pocket: name, domain: server.domain, pocketbaseVersion: config?.pocketbaseVersion || POCKETBASE_VERSION }, folderPath)

    spinner.start("Packaging")
    const files = await collectPocketFiles(folderPath)
    if (Object.keys(files).length === 0) throw new ValidationError("Nothing to deploy (folder is empty)")
    const zipData = zipSync(files, { level: 6 })
    spinner.succeed(`Packaged ${Object.keys(files).length} files (${formatBytes(zipData.length)})`)

    spinner.start("Uploading")
    const client = new SiteioClient()
    const info = await client.deployPocket(name, zipData, {
      version: config?.pocketbaseVersion || POCKETBASE_VERSION,
      deployedBy: getUsername() || undefined,
      google: options.googleClientId && options.googleClientSecret
        ? { clientId: options.googleClientId, clientSecret: options.googleClientSecret }
        : undefined,
    })
    spinner.succeed("Deployed")

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: info }, null, 2))
    } else {
      console.error("")
      console.error(formatSuccess("Pocket deployed successfully!"))
      console.error(`  URL:   ${chalk.cyan(info.url)}`)
      console.error(`  Admin: ${chalk.cyan(info.adminUrl)} ${chalk.dim("(run 'siteio pocket admin' for credentials)")}`)
      console.error("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
```

- [ ] **Step 4: Run the collector test to verify it passes**

Run: `bun test src/__tests__/unit/pocket-deploy-collect.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement `list`, `info`, `logs`, `rm`, `admin`**

```typescript
// src/commands/pocket/list.ts
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { handleError } from "../../utils/errors.ts"

export async function pocketListCommand(options: { json?: boolean } = {}): Promise<void> {
  try {
    const pockets = await new SiteioClient().listPockets()
    if (options.json) {
      console.log(JSON.stringify({ success: true, data: pockets }, null, 2))
    } else if (pockets.length === 0) {
      console.error(chalk.dim("No pockets deployed."))
    } else {
      for (const p of pockets) {
        console.error(`${chalk.bold(p.name)}  ${chalk.cyan(p.url)}  ${chalk.dim(p.status)}`)
      }
    }
    process.exit(0)
  } catch (err) { handleError(err) }
}
```

```typescript
// src/commands/pocket/info.ts
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { resolvePocketName } from "../../utils/site-config.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export async function pocketInfoCommand(name: string | undefined, options: { json?: boolean } = {}): Promise<void> {
  try {
    const server = getCurrentServer()
    const resolved = resolvePocketName(name, server?.domain ?? "")
    if (!resolved) throw new ValidationError("Pocket name required (argument or .siteio/config.json)")
    const info = await new SiteioClient().getPocket(resolved)
    if (options.json) {
      console.log(JSON.stringify({ success: true, data: info }, null, 2))
    } else {
      console.error(`${chalk.bold(info.name)}`)
      console.error(`  URL:     ${chalk.cyan(info.url)}`)
      console.error(`  Admin:   ${chalk.cyan(info.adminUrl)}`)
      console.error(`  Status:  ${info.status}`)
      console.error(`  Version: ${info.version ?? "-"} (PocketBase ${info.pocketbaseVersion})`)
    }
    process.exit(0)
  } catch (err) { handleError(err) }
}
```

```typescript
// src/commands/pocket/logs.ts
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { resolvePocketName } from "../../utils/site-config.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export async function pocketLogsCommand(name: string | undefined, options: { tail?: number; json?: boolean } = {}): Promise<void> {
  try {
    const server = getCurrentServer()
    const resolved = resolvePocketName(name, server?.domain ?? "")
    if (!resolved) throw new ValidationError("Pocket name required (argument or .siteio/config.json)")
    const logs = await new SiteioClient().getPocketLogs(resolved, options.tail ?? 100)
    if (options.json) {
      console.log(JSON.stringify({ success: true, data: logs }, null, 2))
    } else {
      console.log(logs.logs)
    }
    process.exit(0)
  } catch (err) { handleError(err) }
}
```

```typescript
// src/commands/pocket/rm.ts
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { resolvePocketName } from "../../utils/site-config.ts"
import { confirm } from "../../utils/prompt.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export async function pocketRmCommand(name: string | undefined, options: { yes?: boolean; json?: boolean } = {}): Promise<void> {
  try {
    const server = getCurrentServer()
    const resolved = resolvePocketName(name, server?.domain ?? "")
    if (!resolved) throw new ValidationError("Pocket name required (argument or .siteio/config.json)")
    if (!options.yes) {
      const ok = await confirm(`Remove pocket '${resolved}' and its data? This cannot be undone.`)
      if (!ok) process.exit(0)
    }
    await new SiteioClient().deletePocket(resolved)
    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { deleted: resolved } }, null, 2))
    } else {
      console.error(formatSuccess(`Removed pocket ${chalk.bold(resolved)}`))
    }
    process.exit(0)
  } catch (err) { handleError(err) }
}
```

```typescript
// src/commands/pocket/admin.ts
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { resolvePocketName } from "../../utils/site-config.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export async function pocketAdminCommand(name: string | undefined, options: { json?: boolean } = {}): Promise<void> {
  try {
    const server = getCurrentServer()
    const resolved = resolvePocketName(name, server?.domain ?? "")
    if (!resolved) throw new ValidationError("Pocket name required (argument or .siteio/config.json)")
    const admin = await new SiteioClient().getPocketAdmin(resolved)
    if (options.json) {
      console.log(JSON.stringify({ success: true, data: admin }, null, 2))
    } else {
      console.error(`Admin UI: ${chalk.cyan(admin.adminUrl)}`)
      console.error(`  Email:    ${chalk.bold(admin.email)}`)
      console.error(`  Password: ${chalk.bold(admin.password)}`)
    }
    process.exit(0)
  } catch (err) { handleError(err) }
}
```

- [ ] **Step 6: Register the subcommands in `src/cli.ts`**

Add to the `pocket` group created in Task 10:

```typescript
pocket
  .command("deploy [folder]")
  .description("Deploy the pocket (frontend + PocketBase backend)")
  .option("--google-client-id <id>", "Enable Google login (requires --google-client-secret)")
  .option("--google-client-secret <secret>", "Google OAuth client secret")
  .action(async (folder, options) => {
    const { pocketDeployCommand } = await import("./commands/pocket/deploy.ts")
    await pocketDeployCommand(folder, { ...options, json: program.opts().json })
  })

pocket
  .command("list")
  .alias("ls")
  .description("List all pockets")
  .action(async () => {
    const { pocketListCommand } = await import("./commands/pocket/list.ts")
    await pocketListCommand({ json: program.opts().json })
  })

pocket
  .command("info [name]")
  .description("Show detailed info about a pocket")
  .action(async (name) => {
    const { pocketInfoCommand } = await import("./commands/pocket/info.ts")
    await pocketInfoCommand(name, { json: program.opts().json })
  })

pocket
  .command("logs [name]")
  .description("Show logs from a pocket")
  .option("-t, --tail <n>", "Number of lines", parseInt, 100)
  .action(async (name, options) => {
    const { pocketLogsCommand } = await import("./commands/pocket/logs.ts")
    await pocketLogsCommand(name, { ...options, json: program.opts().json })
  })

pocket
  .command("rm [name]")
  .description("Remove a pocket and its data")
  .option("-y, --yes", "Skip confirmation")
  .action(async (name, options) => {
    const { pocketRmCommand } = await import("./commands/pocket/rm.ts")
    await pocketRmCommand(name, { ...options, json: program.opts().json })
  })

pocket
  .command("admin [name]")
  .description("Show the PocketBase admin URL and superuser credentials")
  .action(async (name) => {
    const { pocketAdminCommand } = await import("./commands/pocket/admin.ts")
    await pocketAdminCommand(name, { json: program.opts().json })
  })
```

- [ ] **Step 7: Run full test suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: all tests PASS; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/commands/pocket/ src/cli.ts src/__tests__/unit/pocket-deploy-collect.test.ts
git commit -m "feat(pocket): add deploy, list, info, logs, rm, admin CLI commands"
```

---

## Task 12: End-to-end manual verification

**Files:** none (verification only).

- [ ] **Step 1: Local dev loop (no Docker)**

Run:
```bash
bun run src/cli.ts pocket init /tmp/vibe && \
bun run src/cli.ts pocket dev /tmp/vibe
```
Expected: PocketBase binary downloads once, prints `http://127.0.0.1:8090`. In a browser: the starter page loads; `/_/` shows the admin setup; `/api/health` returns JSON; the `notes` collection exists (migration applied).

- [ ] **Step 2: Deploy against a real agent** (requires a siteio agent with Docker + login)

Run: `bun run src/cli.ts pocket deploy /tmp/vibe`
Expected: prints the pocket URL + admin URL. `curl https://vibe.<domain>/api/health` returns healthy. `siteio pocket admin` prints working superuser credentials that log into `/_/`.

- [ ] **Step 3: Data-safety check (the core invariant)**

Create a record via the API/admin, then redeploy: `bun run src/cli.ts pocket deploy /tmp/vibe`. Confirm the record still exists after redeploy (pb_data preserved; only code replaced).

- [ ] **Step 4: Cleanup**

Run: `bun run src/cli.ts pocket rm vibe -y` and confirm it disappears from `siteio pocket list`.

---

## Self-Review

**1. Spec coverage** (against `docs/superpowers/specs/2026-07-01-pocket-primitive-design.md`):
- §5 workflow (init → dev → deploy) → Tasks 4, 10, 11. ✓
- §6 `.siteio/` layout, folder root = web root, pb_data gitignored → Task 4 + Task 3 (`resolveDevPaths`). ✓
- §7 commands init/dev/deploy/list/info/logs/rm/admin → Tasks 10-11. ✓
- §8 one container per pocket, code read-only mount + pb_data volume, shipped pinned image, Traefik labels → Tasks 5, 6, 7. ✓
- §8 deploy artifact boundary (pb_data excluded) → Task 11 `collectPocketFiles` + explicit test. ✓
- §9 email/password default (PocketBase built-in, no code needed), optional Google via env + hook, superuser-only admin auto-generated + `pocket admin` → Tasks 5 (`writeGoogleHook`), 6 (entrypoint superuser upsert), 7 (cred generation + `/admin`), 11 (`admin` cmd, google flags). ✓
- §10 version pinning single source of truth → Task 1 constants used everywhere. ✓
- §12 non-goals: backups, scale-to-zero, extra social providers — correctly NOT implemented. ✓

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". The two non-code deliverables (the shipped image in Task 6, CI publish note; the version-specific Google settings body in Task 5) are called out explicitly with concrete content and a manual-verification boundary — not placeholders.

**3. Type consistency:** `Pocket`/`PocketInfo` fields defined in Task 1 are used identically in Tasks 5, 7, 8. `deployPocket(name, zipData, opts)` signature matches between client (Task 8) and command (Task 11). `POCKETBASE_IMAGE`/`POCKETBASE_VERSION` referenced consistently. Container port `8090` consistent across image entrypoint (Task 6), deploy handler labels (Task 7), and dev default (Task 10). `getCodePath`/`getDataPath` used identically in Tasks 5 and 7.

**Known follow-ups surfaced during planning (not blockers):**
- CI job to build/publish `ghcr.io/plosson/siteio-pocketbase:<version>` on version bump (Task 6 note).
- The Google-provider settings body in `writeGoogleHook` targets the pinned PocketBase version; re-verify when bumping `POCKETBASE_VERSION`.
