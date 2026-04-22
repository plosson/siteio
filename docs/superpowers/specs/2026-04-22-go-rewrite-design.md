# siteio Go Rewrite — Design Spec

**Date:** 2026-04-22
**Status:** Draft, pending approval
**Motivation:** Shrink the distributed binary from ~65 MB (Bun-compiled) to ~10–15 MB. Startup latency is already fine (~24 ms) and is not the driver.

---

## 1. Scope and constraints

**In scope:** Full 1:1 behavioral port of the current TypeScript codebase to Go. Every CLI command, every agent endpoint, every feature. Users switching versions should not notice any change other than the binary being smaller.

**Out of scope:**
- Feature changes, refactors, API cleanups, renamed flags. None.
- Data-format migrations. The Go agent reads the exact on-disk layout the TS agent writes.
- New dependencies beyond what behavioral parity requires.

**Transition model:** Hard cutover. When a user runs `siteio update` across the `v1.x → v2.0` boundary, the old TS binary pulls down the new Go binary, swaps itself in, and the agent restarts. No parallel running, no migration step.

**Repository strategy:** A new `go/` directory at the repo root. TS and Go coexist on `main` during the port. Both build in CI. At cutover, the TS tree (`src/`, `bun.lock`, `playwright.config.ts`, `node_modules/`, the `bun` scripts in `package.json`) is deleted in a single PR.

---

## 2. Library choices

Target: **Go 1.25** (latest stable as of this spec). `go.mod` declares `go 1.22` as the floor so the enhanced `net/http.ServeMux` routing is available.

| Area | Pick | Why |
|---|---|---|
| CLI framework | **cobra** (`github.com/spf13/cobra`) | Dominant, mature, built-in shell completion generation replaces the 316-line hand-rolled `completion.ts`. |
| HTTP server | **stdlib `net/http`** (1.22+ routing) | Method-qualified patterns (`GET /apps/{name}`) remove the need for chi. |
| Logging | **stdlib `log/slog`** | Modern structured logging; text handler for CLI output, json handler for agent logs. |
| Embedded assets | **stdlib `embed`** | Admin UI HTML/CSS/JS, skill content. |
| YAML (Traefik config) | **`gopkg.in/yaml.v3`** | Standard. |
| SSH | **shell out to `ssh`** | Matches existing TS pattern; reuses ssh-agent, known_hosts, config. |
| Docker | **shell out to `docker`** | Same as TS. Avoids pulling in ~15–20 MB of Docker SDK dependencies. |
| Git | **shell out to `git`** | Same as TS. ssh-agent and HTTPS token handling "just work". |
| Testing | **stdlib `testing` + `httptest`** | No testify. Table-driven where it fits. |
| HTTP client | stdlib `net/http.Client` | Used by the CLI to call the agent. |

**Not picked and noted:** no ORM (storage is file-based), no web framework, no assertion library, no YAML-v2, no viper (flag parsing via cobra is enough), no zap/logrus.

---

## 3. Project layout

```
go/
├── go.mod                          # module github.com/plosson/siteio
├── cmd/
│   └── siteio/
│       └── main.go                 # entry point: wires cobra, dispatches to subcommands
├── internal/
│   ├── types/                      # ports src/types.ts — shared structs w/ JSON tags
│   ├── config/                     # client config loader (~/.config/siteio/config.json)
│   ├── client/                     # HTTP client for CLI → agent (ports src/lib/client.ts)
│   ├── cli/                        # cobra commands
│   │   ├── sites/                  # sites deploy/list/info/rm/...
│   │   ├── apps/                   # apps create/deploy/logs/...
│   │   ├── agent/                  # agent install/start/stop/...
│   │   ├── groups/
│   │   ├── login.go, status.go, skill.go, completion.go, update.go
│   ├── agent/
│   │   ├── server/                 # HTTP routes, auth, handler orchestration
│   │   ├── storage/                # site + app metadata, on-disk schema readers
│   │   ├── docker/                 # shell-out wrapper for docker CLI
│   │   ├── git/                    # shell-out wrapper for git CLI
│   │   ├── traefik/                # dynamic config writer, nginx reload
│   │   ├── compose/                # compose override builder
│   │   ├── oauth/                  # OIDC discovery, cookie middleware
│   │   └── ui/                     # embed.FS for admin UI assets
│   ├── output/                     # JSON-to-stdout, human-to-stderr helpers
│   ├── errors/                     # ValidationError, ApiError, ConfigError
│   └── ssh/                        # remote install SSH shell-out
└── testdata/                       # fixtures: sanitized snapshot of /data, golden files
```

**Package discipline:**
- All code under `internal/` — siteio is a binary, not a library; no stable public API.
- One Go package per current TS module. No consolidation or splitting during the port. Makes review tractable and lets us retire files one-for-one.
- Module path `github.com/plosson/siteio` (matches the GitHub repo).

---

## 4. On-disk data compatibility

The Go agent must read, byte-for-byte, everything the TS agent writes. Data layout reference:

| Path | Source (TS) | Content |
|---|---|---|
| `$DATA/sites/<subdomain>/` | `storage.ts` | Per-site deployed files + versioned snapshots. |
| `$DATA/sites/metadata.json` | `storage.ts` | Site metadata: oauth, domains, versions, sizes, deployedBy. |
| `$DATA/apps/apps.json` | `app-storage.ts` | Container app definitions (`App` structs). |
| `$DATA/apps/dockerfiles/<name>` | `dockerfile-storage.ts` | Inline Dockerfiles uploaded by clients. |
| `$DATA/apps/compose/<name>/` | `compose-storage.ts` | Compose files + `.env` uploads. |
| `$DATA/apps/persistent/<name>/` | `persistent-storage.ts` | Persistent localStorage mounts. |
| `$DATA/groups.json` | `groups.ts` | Email groups for access control. |
| `$DATA/oauth.json` | `config/oauth.ts` | OIDC config: issuer, client_id/secret, cookie_secret, discovered endpoints. |
| `$DATA/traefik/traefik.yml` | `traefik.ts` | Traefik static config. |
| `$DATA/traefik/dynamic.yml` | `traefik.ts` | Traefik dynamic (routers, middlewares, services). |
| `$DATA/traefik/acme.json` | Traefik container | ACME certs. **siteio never reads/writes this** — it is owned by Traefik. |
| `$DATA/traefik/nginx.conf` (approx) | `traefik.ts` | Nginx routing for static sites. |
| `~/.config/siteio/config.json` | `config/loader.ts` | Client-side: servers, current, username. |

**Strategy:**
1. **Snapshot the live `/data`** from the current server into `go/testdata/live-snapshot-YYYY-MM/`, with secrets redacted (`oauth.json` client_secret / cookie_secret, `acme.json` excluded entirely). This is the ground truth.
2. **Port `src/types.ts` first**, in one PR, as `internal/types/`. Every downstream package depends on this. JSON tags mirror the TS field names exactly (including `omitempty` semantics).
3. **Round-trip tests.** For each storage package: parse the snapshot → serialize → byte-compare (JSON files) or semantic-compare (YAML, where key ordering may differ).
4. **No schema changes.** Quirks like the `tokenSet` scrubbing in `server.ts:20` (strip `token`, surface `tokenSet` boolean) are preserved as-is.
5. **Runtime marker.** The Go agent writes `$DATA/.siteio-runtime` (JSON: `{"runtime":"go","version":"<tag>"}`) on first start. Informational only; nothing reads it.

---

## 5. HTTP wire contract

The agent's HTTP API is preserved 1:1:
- Same paths, verbs, query params, headers.
- Same `{success, data?, error?}` envelope (`ApiResponse<T>`).
- Same status codes, including any existing inconsistencies.
- `X-API-Key` auth header, same plain string comparison as TS (`server.ts:97-100`).
- Same multipart field names for uploads (sites tarball, dockerfile, compose file, env file).
- Same streaming format for `apps logs` (chunked transfer via `docker logs --follow` shell-out).
- Error message strings remain identical where the CLI parses them.

Validation is done by normal integration tests hitting a running Go agent with the same inputs the TS agent accepts. The API surface is small enough that elaborate fixture capture is unnecessary.

---

## 6. Port order — vertical slices

Each slice leaves the tree buildable and both binaries shippable.

**Slice 0 — Foundation.**
`go/` scaffold, `go.mod`, `cmd/siteio/main.go` stub that prints version, CI job (`go build ./... && go test ./...`) alongside existing `bun test`, port `src/types.ts` → `internal/types/`.

**Slice 1 — Agent: sites CRUD + Traefik.**
Port `storage.ts`, `traefik.ts`, site-related routes from `server.ts`. End state: Go agent serves `sites deploy/list/info/rm/rename/auth/domain/set/history/rollback/download` to the TS CLI.

**Slice 2 — Agent: apps lifecycle.**
Port `app-storage.ts`, `docker.ts`, `git.ts`, `dockerfile-storage.ts`, `compose-storage.ts`, `compose-override.ts`, `persistent-storage.ts`, app-related routes. End state: full app lifecycle via TS CLI.

**Slice 3 — Agent: groups, OAuth, admin UI.**
`groups.ts`, `config/oauth.ts`, `config/oidc-discovery.ts`, admin UI via `embed.FS`. **Agent is feature-complete. Ship as `v2.0.0-alpha`**; swap the binary on the production server and verify nothing changes.

**Slice 4 — CLI: sites, apps, login, status, config.**
Port `src/commands/sites/*`, `src/commands/apps/*`, `login.ts`, `logout.ts`, `status.ts`, `config.ts`, `src/lib/client.ts`, `src/utils/{output,errors,prompt,site-config,token}.ts`. Cobra wiring.

**Slice 5 — CLI: groups, skill, remote-agent, completion, update.**
`src/commands/groups.ts`, `src/commands/skill.ts`, `src/commands/agent/*` (includes 637-line SSH install), `src/commands/completion.ts` (replaced by cobra built-in), `src/commands/update.ts`, `src/lib/cloudflare.ts`, `src/lib/verification.ts`, `src/utils/ssh.ts`.

**Slice 6 — Cutover.**
Repoint `package.json`, update release workflow to build Go binaries, update install script/README, delete `src/`, `bun.lock`, `playwright.config.ts`, Bun-specific CI jobs. Single PR.

**Rough sizing:**
- Slice 0: half a day.
- Slice 1: ~2k TS lines. Traefik YAML generation is the fiddly part.
- Slice 2: ~3k lines. Biggest slice (Docker, git, compose, uploads).
- Slice 3: ~1.5k lines + asset embedding.
- Slice 4: ~3k lines, straightforward.
- Slice 5: ~2k lines + SSH install.
- Slice 6: ~1 day.

**Discipline during the port:**
- No new features to the TS codebase during Slices 1–3 (agent port). Bug fixes only, applied to both.
- Same rule for the CLI during Slices 4–5.

---

## 7. Testing, CI, release

**Testing.**
- Stdlib `testing` + `httptest`.
- Agent tests spin up an `httptest.Server` wrapping the real handler (same pattern as current TS e2e tests with random-port `AgentServer`).
- One fixture per storage package under `go/testdata/` — sanitized slice of real `/data`.
- Docker/git/ssh shell-outs behind a tiny `Runner` interface with a fake for unit tests. Integration tests use real binaries (matches current `skipTraefik: true` pattern).
- No coverage target. Tests go where they catch bugs.

**CI during port (`.github/workflows/`).**
- New job: `go test ./go/...` and `go build ./go/...` on every PR, alongside existing `bun test` and `bun run typecheck`. Both must pass.
- Release workflow unchanged — ships Bun-compiled binary until Slice 6.

**CI at cutover.**
- Release replaced with: `go build -trimpath -ldflags="-s -w -X main.version=$TAG" ./go/cmd/siteio` for linux/amd64, linux/arm64, darwin/amd64, darwin/arm64.
- No UPX.
- Binaries published under the **same GitHub asset names** (`siteio-linux-amd64`, `siteio-darwin-arm64`, etc.) so existing `src/commands/update.ts` can fetch them during the final TS→Go hop.
- Bun CI jobs deleted.

**The `siteio update` bridge.**
1. Same asset names = the existing TS `update` command pulls the Go binary down and swaps itself with no code change.
2. One pre-cutover TS release with a one-line notice when crossing to `v2.0.0` ("siteio 2.0 is a Go rewrite — same features, smaller binary"). Optional; no behavioral change.

**Versioning.**
- Go release is `v2.0.0`. Semver-major because the runtime changed, even though behavior is identical. Honest signal.
- Post-cutover, resume normal semver.

---

## 8. Risks and open questions

**Known risks:**
- **Traefik YAML formatting.** If key ordering or quoting differs, Traefik itself doesn't care, but human diffs during debugging look noisy. Mitigation: semantic-compare in tests, don't worry about byte-exact YAML.
- **`embed.FS` and skill content.** Skill install currently reads from `src/lib/skill-content.ts` (a TS constant). Ports to an `embed.FS` over the skill files. No behavioral change.
- **SSH install (637 lines).** The densest single TS file in the port. Splitting into `detect-target`, `bootstrap-docker`, `install-binary`, `systemd-unit`, `configure-traefik` during the port will make it reviewable.
- **Binary size target (10–15 MB) is an estimate.** Real number depends on what cobra + slog + net/http pull in transitively. Re-measure at end of Slice 0; adjust expectations if materially different.

**Non-risks (explicitly):**
- Startup latency. Go will be faster, but TS is already sub-50ms and nobody's complaining.
- API compat. The API is small and shaped-tightly; normal tests cover it.
- User-visible behavior. 1:1 port means if anything changes, it's a bug.

**No open questions blocking implementation.**

---

## 9. Success criteria

1. Single Go binary ships as `v2.0.0` and is ≤ 20 MB (target 10–15) on linux-amd64.
2. A user running `v1.x` runs `siteio update` once, ends up on `v2.0.0`, and every existing command works unchanged.
3. The agent on the production server (`ssh siteio`) restarts on the Go binary with no on-disk data change and serves all existing sites/apps without intervention.
4. Zero regressions on the CLI surface — the `tests/` harness that passes on `v1.x` passes on `v2.0.0` (whatever we port of it).
5. `src/` is deleted from `main`.

---

## 10. Non-goals (for the record)

- Replacing any library (no migration to a different HTTP router, no logger swap).
- Improving performance beyond what Go naturally gives.
- Reducing feature count. If a feature exists in TS on cutover day, it exists in Go on cutover day.
- Adding tests that don't exist today (unless required to de-risk a port).
- Breaking backward compatibility of stored data, the HTTP API, or the `~/.config/siteio/config.json` format.
