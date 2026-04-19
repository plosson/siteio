# Docker Compose support for `siteio apps`

**Status:** Design approved 2026-04-19
**Scope:** Extend `siteio apps create/deploy/...` to accept a `docker-compose.yml` as an alternative to a single image / Dockerfile / git-backed Dockerfile.

## Goal

Let users deploy apps that need siblings (database, cache, worker) by pointing siteio at a compose file — inline or inside a git repo — with exactly **one** service publicly exposed through Traefik. Dependencies run alongside the primary service on the same compose project network; only the primary service is reachable from outside.

All existing single-container semantics (domains, OAuth, env vars, volumes, restart policy) continue to work and, by default, target the primary service.

## Non-goals

- Multi-service public exposure (multiple subdomains off one compose file).
- Arbitrary compose workloads where Traefik routing is user-managed.
- Compose `profiles`, `extends` across files siteio didn't write, or user-defined override files beyond the single file siteio consumes.
- Private git credentials (same limitation as today's git flow).
- End-to-end automated testing of real `docker compose up` invocations (matches current policy for the Docker flows).

## User experience

### Creating a compose app

Local compose file (uploaded and stored server-side, like inline Dockerfiles today):

```bash
siteio apps create myapp \
  --compose-file ./docker-compose.yml \
  --service web \
  -p 3000 \
  -d myapp.example.com
```

Git-hosted compose file (cloned on the server):

```bash
siteio apps create myapp \
  --git https://github.com/user/repo \
  --compose docker-compose.prod.yml \
  --service web \
  -p 3000 \
  -d myapp.example.com
```

### New / modified flags

| Flag | Meaning | Notes |
|---|---|---|
| `--compose-file <path>` | Local compose file to upload | Mutually exclusive with `-i`, `-f`, `--git` |
| `--compose <path>` | Path to compose file inside git repo | Requires `--git`; mutually exclusive with `--dockerfile` |
| `--service <name>` | Primary service to expose via Traefik | **Always required** whenever compose is in use; no inference |
| `-p/--port <port>` | Internal port on the primary service | Unchanged semantics; Traefik's `loadbalancer.server.port` |
| `apps logs --service <name>` | Show logs for a specific compose service | New; compose-apps only |
| `apps logs --all` | Show logs for every service in the project | New; compose-apps only |

### Validation rules (CLI + server)

1. Exactly one source: `image` XOR `file` (inline Dockerfile) XOR `compose-file` (inline compose) XOR `git` (with optional `--dockerfile` OR `--compose`, defaulting to Dockerfile for backwards compatibility).
2. When `git` is the source, at most one of `--dockerfile` / `--compose`.
3. `--service` is required **if and only if** the app is compose-based.
4. `apps logs --service` / `--all` are only valid on compose-based apps; using them elsewhere returns `400 ValidationError`.

## Architecture

### Data model (`src/types.ts`)

Add to the `App` interface:

```typescript
type ComposeSource =
  | { source: "inline"; primaryService: string }
  | { source: "git"; path: string; primaryService: string };

interface App {
  // ...existing fields...
  compose?: ComposeSource;
}
```

Presence of `compose` is the single marker distinguishing a compose app from a container app. Existing apps deserialize with `compose: undefined`; no migration is needed.

Relationship to existing fields:

- **Inline compose:** `compose: {source: "inline", primaryService}`, `git: undefined`. Base file lives at `${dataDir}/compose/${appName}/docker-compose.yml`.
- **Git-hosted compose:** `compose: {source: "git", path, primaryService}` **and** `git: GitSource` is set (same shape used today). The `path` inside `ComposeSource` is the relative path to the compose file within the cloned repo; the existing `dockerfile` path on `GitSource` is ignored/unused in this mode.

Exclusivity invariant (enforced at write time):

- Exactly one of: `image`, `dockerfile` (inline), `compose` (inline), `git+dockerfile`, `git+compose`.
- In concrete field terms: `image`, `dockerfile`, and `compose` are mutually exclusive; `git` may be present alongside `compose` (new) or alongside `GitSource.dockerfile` (existing), but never with both `compose` set and a `GitSource.dockerfile` path meaningfully used.

### Storage

New helper class `src/lib/agent/compose-storage.ts`, parallel to `src/lib/agent/dockerfile-storage.ts`:

- **Inline compose:** written to `${dataDir}/compose/${appName}/docker-compose.yml` on `POST /apps`.
- **Git compose:** no upload; the compose file lives inside the cloned repo at `${dataDir}/git/${appName}/<path>`.
- **Generated override:** written to `${dataDir}/compose/${appName}/docker-compose.siteio.yml` on every deploy (for both inline and git sources).

`ComposeStorage` exposes: `writeBaseInline(appName, contents)`, `baseInlinePath(appName)`, `overridePath(appName)`, `writeOverride(appName, yaml)`, `remove(appName)`.

### Override file generator (`src/lib/agent/compose-override.ts`)

Pure function `buildOverride(app: App): string` that emits YAML of the form:

```yaml
services:
  <primaryService>:
    networks:
      - siteio-network
    labels:
      traefik.enable: "true"
      traefik.docker.network: "siteio-network"
      traefik.http.routers.siteio-<name>.entrypoints: "websecure"
      traefik.http.routers.siteio-<name>.tls.certresolver: "letsencrypt"
      traefik.http.routers.siteio-<name>.rule: "Host(`d1`) || Host(`d2`)"
      traefik.http.services.siteio-<name>.loadbalancer.server.port: "<internalPort>"
      # OAuth middleware labels when app.oauth is set
    environment:
      # user-set env vars from app.env (primary-service-only)
      KEY: value

networks:
  siteio-network:
    external: true
```

Label generation reuses `buildTraefikLabels()` from `src/lib/agent/docker.ts:293` — the same key/value pairs, rendered into YAML instead of CLI `-l` args. This ensures compose and non-compose apps get identical Traefik routing semantics (OAuth middleware, TLS resolver, entrypoints).

Volumes from `app.volumes` also merge into the primary service's `volumes:` list.

**Merge precedence with the user's base file.** Compose's merge rules apply when `docker compose -f base -f override` combines the two: for **maps** (e.g. `labels:`, `environment:` in map form), override keys win per key; for **lists** (e.g. `volumes:`, `networks:`), entries are concatenated.

The override always emits `environment:` and `labels:` in **map form** so individual keys merge cleanly against the base. If the base declares `environment:` in list form (`["KEY=value"]`), compose normalizes both to maps before merging, so the behavior is consistent. If the user sets `KEY=foo` in their base file and then `siteio apps set-env KEY=bar`, the override's `bar` wins. This is the documented and desired behavior: siteio's env settings override the base for the primary service.

### Runtime abstraction (`src/lib/agent/runtime.ts`) — new seam

Introduce an interface to decouple `AgentServer` from the concrete docker/docker-compose shelling:

```typescript
interface Runtime {
  // Container (single-container apps)
  pull(image: string): Promise<void>;
  build(ctx: BuildConfig): Promise<void>;
  run(cfg: RunConfig): Promise<string>;           // returns containerId
  stop(name: string): Promise<void>;
  restart(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  logs(name: string, tail: number): Promise<LogOutput>;
  inspectStatus(name: string): Promise<ContainerStatus>;

  // Compose
  composeConfig(project: string, files: string[]): Promise<ComposeSpec>;   // `docker compose ... config --format json`
  composeUp(project: string, files: string[]): Promise<void>;              // `up -d --build --remove-orphans`
  composeStop(project: string, files: string[]): Promise<void>;            // `stop`
  composeRestart(project: string, files: string[]): Promise<void>;         // `restart`
  composeDown(project: string, files: string[]): Promise<void>;            // `down -v --remove-orphans`
  composeLogs(project: string, files: string[], opts: { service?: string; all?: boolean; tail: number }): Promise<LogOutput>;
  composePs(project: string, files: string[]): Promise<ComposeServiceState[]>;
}
```

Default implementation wraps the existing `DockerManager` for container methods and a new `ComposeManager` (`src/lib/agent/compose.ts`) for compose methods, all via `spawnSync`. `AgentServer` accepts `Runtime` in its constructor; production wires the real implementation; tests inject a `FakeRuntime`.

This seam is independently valuable beyond compose — it makes the existing image/Dockerfile/git flows testable at the command-generation level for the first time.

### Deploy pipeline changes (`src/lib/agent/server.ts:handleDeployApp`)

New branch when `app.compose` is set:

```
1. Resolve base compose file:
   - inline:  ${dataDir}/compose/${appName}/docker-compose.yml
   - git:     clone/pull repo → ${dataDir}/git/${appName}/<path>
2. Generate override → ${dataDir}/compose/${appName}/docker-compose.siteio.yml
3. runtime.composeConfig("siteio-<name>", [base, override])
   → parse JSON, assert services[primaryService] exists
   → fail with 400 + clear error if it doesn't
4. runtime.composeUp("siteio-<name>", [base, override])
5. runtime.composePs("siteio-<name>", [base, override])
   → find container for primaryService → store in app.containerId
6. Update status, deployedAt, lastBuildAt, commitHash (for git)
```

Existing image / Dockerfile / git+Dockerfile branch is untouched.

**Rebuild semantics.** `siteio apps deploy` on a git-backed compose app performs `git pull`, then `composeUp` with `up -d --build --remove-orphans`. `docker compose` handles incremental rebuild of any service with a `build:` directive. Siteio adds no custom build logic.

### Compose project naming

All compose invocations use `-p siteio-${appName}` (explicit project name), ensuring:

- Containers are named predictably (`siteio-<app>-<service>-1`).
- No collisions between two apps that happen to have the same service names.
- `apps delete` scopes `compose down -v` to only this app's volumes.

### Lifecycle commands (`src/lib/agent/server.ts`)

Each lifecycle handler branches on `app.compose`:

| Command | Single-container (existing) | Compose branch (new) |
|---|---|---|
| `apps stop` | `runtime.stop(name)` | `runtime.composeStop(project, files)` |
| `apps restart` | `runtime.restart(name)` | `runtime.composeRestart(project, files)` |
| `apps logs` | `runtime.logs(name, tail)` | default: `composeLogs({service: primary, tail})` <br> `--service <x>`: `composeLogs({service: x, tail})` <br> `--all`: `composeLogs({tail})` (no service filter) |
| `apps delete` | stop + remove container, clean git/dockerfile/image/metadata | `composeDown(project, files)` (removes project-scoped volumes only), clean git/compose-dir/metadata |
| `apps list` / status | `runtime.inspectStatus(name)` | `runtime.composePs(project, files)` — app is **running** iff primary service container is running; **degraded** if primary is running but a dependency exited unexpectedly |

**Env & domain updates** (`apps set-env`, `apps set-domains`). Writes to `App.env` / `App.domains` as today. On next `apps deploy`, the override file regenerates and `composeUp` picks up the change. Traefik's Docker provider sees updated labels and swaps routing automatically.

### No YAML library dependency

We do **not** parse compose files ourselves. `runtime.composeConfig()` shells out to `docker compose config --format json`, which is the authoritative parser (`compose-go`) that `docker compose` itself uses. This gives us, in one call:

- Full compose-spec validation (schema errors, unknown keys, bad refs).
- Environment interpolation already applied.
- Merged view of base + override, verifying our override took effect.
- Well-formed JSON consumable via `JSON.parse`, no npm dependency required.

The only YAML we *write* is our override file, which has a small, fixed schema — a templated string is sufficient; no library needed.

## Testing

### Automated

**Unit (pure functions):**

- `compose-override.test.ts` — snapshot-style assertions on the generated override YAML, covering: single domain, multi-domain, env vars, OAuth enabled/disabled, volumes, restart policy.
- `compose-storage.test.ts` — inline file persistence (write / read path / remove).
- CLI flag validation — mutually-exclusive source flags, `--service` required with compose, `--service`/`--all` rejected on non-compose apps.

**API integration with `FakeRuntime`** (new):

- `POST /apps` inline compose → persisted `App` has the expected `compose` shape; no runtime calls made at create time.
- `POST /apps` git + compose-path → persisted correctly.
- `POST /apps/<name>/deploy` inline compose → FakeRuntime records: override file written at expected path, `composeUp` invoked with `siteio-<name>` project and the two expected files.
- Git-hosted compose deploy → clone/pull recorded before `composeUp`.
- `apps stop` / `restart` on compose app → `composeStop` / `composeRestart` called, **not** `stop` / `restart`.
- `apps delete` → `composeDown` called with the project name; metadata and compose directory removed.
- `apps logs` default → `composeLogs({service: primary})`.
- `apps logs --service db` → `composeLogs({service: "db"})`.
- `apps logs --all` → `composeLogs({})`.
- `apps logs --service x` on non-compose app → 400, runtime not called.
- Redeploy after `set-env` → override regenerated with new env, `composeUp` re-invoked.
- Deploy validation: `FakeRuntime.composeConfig()` returns a fixture missing the primary service → 400, `composeUp` not called.
- `composePs()` fixture data → server stores correct primary container ID in `app.containerId`.

**Regression coverage for existing flows** (free win from the runtime seam):

- Image / inline-Dockerfile / git+Dockerfile deploy paths also assert exact runtime calls via `FakeRuntime`. Previously untested at this level.

### Manual (requires a real host)

1. Inline compose with Postgres dependency → app + db come up, app reachable via Traefik with valid TLS at its domain, db reachable only inside project network.
2. Git-hosted compose → redeploy rebuilds `build:` services on new commit.
3. `apps logs --service postgres` shows only Postgres logs.
4. `apps delete` removes all compose project containers + project-scoped volumes, leaves other apps untouched.
5. OAuth labels on primary service gate a compose app behind an email allowlist.
6. Volume persistence across `apps restart`.

## File-by-file impact

**New files:**

- `src/lib/agent/runtime.ts` — `Runtime` interface + default impl wiring `DockerManager` and `ComposeManager`.
- `src/lib/agent/compose.ts` — `ComposeManager` class; thin `spawnSync` wrappers around `docker compose` subcommands.
- `src/lib/agent/compose-storage.ts` — inline-compose + override file persistence helper.
- `src/lib/agent/compose-override.ts` — `buildOverride(app)` pure function.
- `src/__tests__/compose-override.test.ts`
- `src/__tests__/compose-storage.test.ts`
- `src/__tests__/apps-compose.test.ts`
- `src/__tests__/runtime-fake.ts` — test helper (`FakeRuntime` implementing `Runtime`, recording calls).

**Modified files:**

- `src/types.ts` — add `ComposeSource` + `compose?` field on `App`.
- `src/cli.ts` — add `--compose-file`, `--compose`, `--service` to `apps create`; `--service`, `--all` to `apps logs`.
- `src/commands/apps/create.ts` — validation for new flag combinations.
- `src/lib/agent/server.ts` — constructor takes `Runtime`; `handleCreateApp`, `handleDeployApp`, `handleStopApp`, `handleRestartApp`, `handleLogsApp`, `handleDeleteApp`, `handleListApps` all gain a compose branch.
- `src/lib/agent/docker.ts` — unchanged structurally; becomes one backing for `Runtime`.
- Existing tests: updated to construct `AgentServer` with the default runtime (or `FakeRuntime` where assertions benefit).

## Open questions (resolved)

- **Which public-exposure model?** Single primary service only.
- **Source forms?** Local (uploaded) + git (path inside repo). Both supported.
- **Traefik integration style?** Generated override file (`docker-compose.siteio.yml`), keeping user's base file untouched.
- **Single-container lifecycle semantics for compose apps?** Primary-service-by-default (`apps logs`, `set-env`, volumes target primary); `--service` / `--all` opt-ins on `apps logs`.
- **Primary service inference?** None. `--service` is always required when compose is used.
- **Compose parsing?** Shell out to `docker compose config --format json`; no JS YAML/compose library.
