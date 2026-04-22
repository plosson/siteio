# siteio Go Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port siteio from TypeScript/Bun to Go with identical behavior, shrinking the binary from ~65 MB to ~10–15 MB.

**Architecture:** Vertical slices. Each slice leaves the tree buildable and both binaries shippable. Agent ports first (Slices 1–3), CLI second (Slices 4–5), cutover last (Slice 6). `go/` lives at repo root alongside `src/` until cutover. Shell-out for docker/git/ssh preserves exact TS behavior.

**Tech Stack:** Go 1.25 (floor 1.22), cobra, stdlib `net/http`/`log/slog`/`embed`/`testing`/`httptest`, `gopkg.in/yaml.v3`.

**Spec:** `docs/superpowers/specs/2026-04-22-go-rewrite-design.md`.

---

## How this plan is scaled

Slice 0 is **fully TDD-detailed** (exact tests, exact code, exact commands) because it's small and every downstream slice depends on it.

Slices 1–6 are **task-decomposed** with:
- Exact file paths (ported from / created as)
- Concrete test strategy per task (what must be verified, how)
- Commit boundaries
- The TS source as the behavioral specification — executing agents read the named TS file and produce equivalent Go

I do not predict every line of Go in advance. Attempting to do so for ~15k TS lines would produce untested fiction. What I guarantee instead: every task has a clear behavioral target, a test that catches a regression, and a commit point.

---

## Conventions (applies to all slices)

**Working directory:** `go/` at repo root.

**Module:** `github.com/plosson/siteio`.

**File naming:** Lowercase, underscores-in-words: `site_storage.go`, `app_storage.go`. Test files: `site_storage_test.go`.

**Commit messages:** `feat(go): <slice>: <what>`. Example: `feat(go): slice-1: port SiteStorage.listSites`.

**Test command:** `cd go && go test ./... -count=1` (always use `-count=1` to disable test caching during the port).

**Build command:** `cd go && go build ./cmd/siteio`.

**Linting:** `cd go && go vet ./...`. No external linter during the port; adopt `golangci-lint` post-cutover if desired.

**No logging during tests** unless a test asserts on it. Use `slog` with a discard handler.

**Shell-out policy:** Wrap every `exec.Cmd` behind a small `Runner` interface so tests can fake. Do not call `os/exec` directly from business logic.

**Error handling:** Return `error`; don't panic in library code. The CLI may call `log.Fatal` at the top level only.

**Preserve TS error strings verbatim** when the string may be parsed by client code or shown to users.

**Data fixtures:** Sanitized copies of real `/data` go under `go/testdata/`. Secrets (client_secret, cookie_secret, API keys) must be replaced with obvious placeholders like `REDACTED_CLIENT_SECRET`.

---

## Slice 0 — Foundation

**Outcome:** `go/` directory exists with a buildable CLI that prints `--version`. CI runs `go build` and `go test` alongside `bun test`. All TS types from `src/types.ts` are ported to `internal/types/`.

### Task 0.1: Scaffold `go/` with `go.mod` and empty `cmd/siteio/main.go`

**Files:**
- Create: `go/go.mod`
- Create: `go/cmd/siteio/main.go`
- Create: `go/.gitignore`

- [ ] **Step 1: Create `go/go.mod`**

```
module github.com/plosson/siteio

go 1.22
```

- [ ] **Step 2: Create `go/cmd/siteio/main.go`**

```go
package main

import "fmt"

var version = "dev"

func main() {
	fmt.Println(version)
}
```

- [ ] **Step 3: Create `go/.gitignore`**

```
/siteio
/siteio-*
*.test
coverage.out
```

- [ ] **Step 4: Verify build works**

Run: `cd go && go build ./cmd/siteio && ./siteio`
Expected output: `dev`

- [ ] **Step 5: Commit**

```bash
git add go/go.mod go/cmd/siteio/main.go go/.gitignore
git commit -m "feat(go): slice-0: scaffold go module and cmd/siteio entry"
```

### Task 0.2: Add CI job for Go build + test

**Files:**
- Modify: `.github/workflows/ci.yml` (or equivalent; read the file first)

- [ ] **Step 1: Read current workflow**

Run: `ls .github/workflows/` then read the primary CI file.

- [ ] **Step 2: Add a Go job**

Add this job to the workflow (mirror `runs-on` and trigger conventions of existing jobs):

```yaml
  go-build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.25'
      - name: Go build
        run: cd go && go build ./...
      - name: Go vet
        run: cd go && go vet ./...
      - name: Go test
        run: cd go && go test ./... -count=1
```

- [ ] **Step 3: Verify workflow syntax is valid**

Run: `yamllint .github/workflows/ci.yml` (or open in editor to check indentation).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/
git commit -m "feat(go): slice-0: add go build/vet/test CI job"
```

### Task 0.3: Wire `-ldflags` version injection

**Files:**
- Modify: `go/cmd/siteio/main.go`

- [ ] **Step 1: Write test — version default**

Create `go/cmd/siteio/main_test.go`:

```go
package main

import "testing"

func TestVersionDefault(t *testing.T) {
	if version == "" {
		t.Fatal("version must not be empty")
	}
}
```

- [ ] **Step 2: Run test to verify it passes with default "dev"**

Run: `cd go && go test ./cmd/siteio -count=1`
Expected: PASS

- [ ] **Step 3: Verify `-ldflags` injection works at build time**

Run: `cd go && go build -ldflags="-X main.version=1.99.0" -o /tmp/siteio-test ./cmd/siteio && /tmp/siteio-test`
Expected: `1.99.0`

- [ ] **Step 4: Commit**

```bash
git add go/cmd/siteio/main_test.go
git commit -m "feat(go): slice-0: verify ldflags version injection"
```

### Task 0.4: Port `src/types.ts` to `internal/types/`

**Files:**
- Create: `go/internal/types/types.go`
- Create: `go/internal/types/types_test.go`
- Reference: `src/types.ts`

This is the single most important task in Slice 0. Every downstream package depends on these types. JSON tags must match TS field names exactly; `omitempty` applies wherever the TS field is optional (`?:`).

- [ ] **Step 1: Write failing test — round-trip `App` through JSON**

Create `go/internal/types/types_test.go`:

```go
package types

import (
	"encoding/json"
	"testing"
)

func TestAppJSONRoundTrip(t *testing.T) {
	input := `{
  "name": "myapp",
  "type": "container",
  "image": "nginx:alpine",
  "env": {"FOO": "bar"},
  "volumes": [{"name": "data", "mountPath": "/data"}],
  "internalPort": 80,
  "restartPolicy": "unless-stopped",
  "domains": ["example.com"],
  "status": "running",
  "createdAt": "2026-04-22T10:00:00.000Z",
  "updatedAt": "2026-04-22T10:00:00.000Z"
}`
	var app App
	if err := json.Unmarshal([]byte(input), &app); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if app.Name != "myapp" {
		t.Errorf("Name: got %q, want myapp", app.Name)
	}
	if app.Type != "container" {
		t.Errorf("Type: got %q, want container", app.Type)
	}
	if app.Volumes[0].MountPath != "/data" {
		t.Errorf("Volumes[0].MountPath: got %q, want /data", app.Volumes[0].MountPath)
	}
	out, err := json.Marshal(&app)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	// Re-unmarshal to compare structurally
	var got map[string]any
	var want map[string]any
	_ = json.Unmarshal(out, &got)
	_ = json.Unmarshal([]byte(input), &want)
	for k, v := range want {
		if got[k] == nil && v != nil {
			t.Errorf("key %q dropped in round-trip", k)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd go && go test ./internal/types -count=1`
Expected: FAIL (package does not exist yet)

- [ ] **Step 3: Read `src/types.ts` end-to-end**

Read the full file to catalog every interface and its field types.

- [ ] **Step 4: Create `go/internal/types/types.go`**

Port every TS interface to a Go struct. Rules:
- TS `interface Foo { x?: string }` → `type Foo struct { X string \`json:"x,omitempty"\` }`
- TS `type T = "a" | "b"` → `type T string` plus const declarations for each value
- TS `Record<string, string>` → `map[string]string`
- TS `Uint8Array` → `[]byte`
- TS union types like `ComposeSource` (discriminated union) → a struct with all possible fields + `omitempty`, with a `Source` field indicating the variant

Complete list of types to port (from `src/types.ts`):
- `ApiResponse[T]` (generic; use `any` for T or a concrete type per call site — keep as `ApiResponse` with `Data json.RawMessage` for flexibility)
- `SiteOAuth`, `RestartPolicy` (string type + consts), `ContainerStatus`, `AppType`, `VolumeMount`, `GitSource`, `DockerfileSource`, `ComposeSource`, `App`, `AppInfo`, `ContainerLogs`, `ContainerInspect`, `Group`, `TlsStatus`, `SiteInfo`, `ServerConfig`, `ClientConfig`, `AcmeChallengeType`, `AcmeConfig`, `AgentConfig`, `DeployRequest`, `SiteMetadata`, `SiteConfig`, `SiteVersion`, `DeployOptions`, `AuthOptions`, `LoginOptions`, `AgentStartOptions`, `AgentOAuthConfig`

For `ComposeSource`, the TS discriminated union becomes:
```go
type ComposeSource struct {
    Source         string `json:"source"`           // "inline" or "git"
    Path           string `json:"path,omitempty"`   // git only
    PrimaryService string `json:"primaryService"`
}
```

For the `tokenSet` quirk in `GitSource` (set by server on responses, ignored on PATCH), include both `Token` (omitempty, for PATCH inbound) and `TokenSet` (omitempty, for outbound) — the agent server strips `Token` before responding. Behavior is preserved in the handler layer, not in the type.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd go && go test ./internal/types -count=1`
Expected: PASS

- [ ] **Step 6: Add a second test — every enum const round-trips**

Extend `types_test.go`:

```go
func TestRestartPolicyValues(t *testing.T) {
	cases := []RestartPolicy{
		RestartAlways,
		RestartUnlessStopped,
		RestartOnFailure,
		RestartNo,
	}
	for _, c := range cases {
		b, err := json.Marshal(c)
		if err != nil {
			t.Fatalf("marshal %q: %v", c, err)
		}
		var got RestartPolicy
		if err := json.Unmarshal(b, &got); err != nil {
			t.Fatalf("unmarshal %q: %v", c, err)
		}
		if got != c {
			t.Errorf("round-trip: got %q, want %q", got, c)
		}
	}
}
```

Add equivalent tests for `ContainerStatus`, `AppType`, `TlsStatus`, `AcmeChallengeType`.

- [ ] **Step 7: Run tests**

Run: `cd go && go test ./internal/types -count=1 -v`
Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add go/internal/types/
git commit -m "feat(go): slice-0: port src/types.ts to internal/types"
```

### Task 0.5: Set up `internal/errors` package

**Files:**
- Create: `go/internal/errors/errors.go`
- Create: `go/internal/errors/errors_test.go`
- Reference: `src/utils/errors.ts`

- [ ] **Step 1: Read `src/utils/errors.ts`**

Lists `ValidationError`, `ApiError`, `ConfigError`.

- [ ] **Step 2: Write failing test**

`go/internal/errors/errors_test.go`:

```go
package errors

import (
	"errors"
	"testing"
)

func TestValidationError(t *testing.T) {
	err := NewValidation("bad name")
	if err.Error() != "bad name" {
		t.Errorf("Error(): got %q, want %q", err.Error(), "bad name")
	}
	var ve *ValidationError
	if !errors.As(err, &ve) {
		t.Fatal("errors.As should match ValidationError")
	}
}

func TestApiError(t *testing.T) {
	err := NewAPI(404, "not found")
	var ae *APIError
	if !errors.As(err, &ae) {
		t.Fatal("errors.As should match APIError")
	}
	if ae.Status != 404 {
		t.Errorf("Status: got %d, want 404", ae.Status)
	}
}
```

- [ ] **Step 3: Run test (expect FAIL)**

Run: `cd go && go test ./internal/errors -count=1`
Expected: FAIL

- [ ] **Step 4: Implement the package**

`go/internal/errors/errors.go`:

```go
package errors

import "fmt"

type ValidationError struct {
	Message string
}

func (e *ValidationError) Error() string { return e.Message }

func NewValidation(msg string) error {
	return &ValidationError{Message: msg}
}

type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("api error %d: %s", e.Status, e.Message)
}

func NewAPI(status int, msg string) error {
	return &APIError{Status: status, Message: msg}
}

type ConfigError struct {
	Message string
}

func (e *ConfigError) Error() string { return e.Message }

func NewConfig(msg string) error {
	return &ConfigError{Message: msg}
}
```

- [ ] **Step 5: Run test (expect PASS)**

Run: `cd go && go test ./internal/errors -count=1`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add go/internal/errors/
git commit -m "feat(go): slice-0: port error types from src/utils/errors.ts"
```

### Task 0.6: Set up `internal/output` helpers

**Files:**
- Create: `go/internal/output/output.go`
- Create: `go/internal/output/output_test.go`
- Reference: `src/utils/output.ts`

- [ ] **Step 1: Read `src/utils/output.ts`** (108 lines; enumerate every exported helper)

- [ ] **Step 2: Write tests for each helper** (JSON to stdout, human-readable to stderr, success/error formatting, color/no-color handling — check TS behavior for specifics)

- [ ] **Step 3: Implement helpers using `io.Writer` injection**

Every output helper takes `stdout io.Writer, stderr io.Writer` — never calls `fmt.Println` directly. This makes testing trivial.

- [ ] **Step 4: Run tests (expect PASS)**

Run: `cd go && go test ./internal/output -count=1`

- [ ] **Step 5: Commit**

```bash
git add go/internal/output/
git commit -m "feat(go): slice-0: port output helpers from src/utils/output.ts"
```

### Task 0.7: Add README note in `go/`

**Files:**
- Create: `go/README.md`

- [ ] **Step 1: Write `go/README.md`** (short — "this is the Go port, see the spec at `docs/superpowers/specs/2026-04-22-go-rewrite-design.md`")

- [ ] **Step 2: Commit**

```bash
git add go/README.md
git commit -m "docs(go): slice-0: add go/ README pointer"
```

---

## Slice 1 — Agent: sites + Traefik

**Outcome:** A Go agent binary can serve all site-related HTTP endpoints to the existing TS CLI. Traefik dynamic config and nginx config are byte-equivalent (semantically) to what TS produces. The Go agent is invoked via a new `siteio agent start-go` command during this slice (flag-gated) so it can run side-by-side with the TS agent for parity testing.

### Task 1.1: Port `SiteStorage` (`src/lib/agent/storage.ts` → `go/internal/agent/storage/sites.go`)

**Files:**
- Create: `go/internal/agent/storage/sites.go`
- Create: `go/internal/agent/storage/sites_test.go`
- Create: `go/testdata/sites/` (snapshot of a real site's metadata + files)
- Reference: `src/lib/agent/storage.ts` (entire file)

**Behavioral contract:**
- Constructor creates `sites/`, `metadata/`, `history/` subdirs under `dataDir` with mode `0755`.
- `ExtractAndStore(subdomain, zipData, oauth, deployedBy)` — unzips to `sites/<subdomain>/` with mode `0644`, archives existing version to `history/<subdomain>/v<N>/`, prunes above 10 versions.
- Writes metadata JSON to `metadata/<subdomain>.json` with the exact TS field ordering (via `json.MarshalIndent` + correct struct field order — Go's `encoding/json` preserves declaration order).
- `ListSites` returns sorted by `deployedAt` descending.
- `Rollback`, `Rename`, `UpdateOAuth`, `UpdateDomains`, `UpdatePersistentStorage`, `DeleteSite`, `ZipSite`, `GetHistory`, `SiteExists`, `GetMetadata`.

**Test strategy:**
- Table-driven unit tests against a temp dir (`t.TempDir()`).
- One integration test that reads a real metadata snapshot from `testdata/sites/` and asserts structured fields.
- Test that archived versions are pruned to exactly 10.
- Test that rename moves site dir + metadata + history atomically (from test's perspective).

- [ ] **Step 1: Copy a sanitized site from the running server**

Run on the dev machine:
```bash
ssh siteio "tar czf /tmp/siteio-snapshot.tgz -C /data sites metadata history groups.json" && scp siteio:/tmp/siteio-snapshot.tgz /tmp/
mkdir -p go/testdata/live-snapshot
tar xzf /tmp/siteio-snapshot.tgz -C go/testdata/live-snapshot
```
Manually redact anything sensitive before committing. Alternatively, construct a minimal synthetic fixture in `go/testdata/sites/` — this is fine if obtaining a live snapshot is inconvenient.

- [ ] **Step 2: Write failing test — read existing metadata**

```go
// go/internal/agent/storage/sites_test.go
package storage

import (
	"path/filepath"
	"testing"
)

func TestGetMetadata_ReadsLiveFixture(t *testing.T) {
	s := NewSiteStorage(filepath.Join("..", "..", "..", "testdata", "live-snapshot"))
	meta := s.GetMetadata("hello") // adjust subdomain to match fixture
	if meta == nil {
		t.Fatal("expected metadata for 'hello' in snapshot")
	}
	if meta.Subdomain != "hello" {
		t.Errorf("Subdomain: got %q, want hello", meta.Subdomain)
	}
}
```

- [ ] **Step 3: Run test (expect FAIL — package doesn't exist)**

Run: `cd go && go test ./internal/agent/storage -count=1`

- [ ] **Step 4: Implement `SiteStorage`**

Port `src/lib/agent/storage.ts` line-for-line. Use `archive/zip` (stdlib) for zip extraction — not an external library. Preserve `0755` and `0644` mode constants exactly.

- [ ] **Step 5: Run test (expect PASS)**

- [ ] **Step 6: Add tests for `ExtractAndStore`, `DeleteSite`, `ListSites`, `UpdateOAuth`, `UpdateDomains`, `Rollback`, `Rename`, `ZipSite`**

Each test creates a temp dir, writes a small zip to extract, and asserts on disk state.

- [ ] **Step 7: Add `MAX_HISTORY_VERSIONS` pruning test**

Deploy 12 versions, assert only 10 remain.

- [ ] **Step 8: Run full suite**

Run: `cd go && go test ./internal/agent/storage -count=1 -v`

- [ ] **Step 9: Commit**

```bash
git add go/internal/agent/storage/ go/testdata/
git commit -m "feat(go): slice-1: port SiteStorage"
```

### Task 1.2: Port `TraefikManager` — static + dynamic config generation (pure functions first)

**Files:**
- Create: `go/internal/agent/traefik/config.go` (pure generators)
- Create: `go/internal/agent/traefik/config_test.go`
- Reference: `src/lib/agent/traefik.ts` (lines 250–309, 368–530, 532–573 for YAML emit)

**Scope of this task:** Only the pure YAML generators (`generateStaticConfig`, `generateDynamicConfig`, `generateNginxConfig`). Container orchestration (`start`, `stop`, `startNginx`, `startOAuthProxy`) is Task 1.3.

**Behavioral contract:**
- `GenerateStaticConfig(cfg)` returns the Traefik static YAML. Test cases: http challenge, tls challenge, dns challenge (with a provider set).
- `GenerateDynamicConfig(cfg, sites)` returns the Traefik dynamic YAML. Test cases:
  - Empty sites list → only `api-router` and `api-service`.
  - One site, no OAuth → one site router + nginx-service.
  - One site with OAuth restrictions + OAuth configured → middlewares `oauth-errors`, `oauth2-proxy-auth`, `siteio-authz` attached, logout-router added.
  - Custom domains produce `site-<name>-cd-<i>` routers with matching logout routers if OAuth.
  - OAuth configured with `endSessionEndpoint` vs without.
- `GenerateNginxConfig(cfg, sites)` returns nginx config with the subdomain-regex server, plus explicit server blocks for persistent-storage sites and custom domains.

**YAML decision:** use `gopkg.in/yaml.v3` with `yaml.Marshal`. The TS `toYaml` emits hand-rolled YAML with JSON-quoted scalars (`JSON.stringify(value)`); `yaml.v3` output will differ formatting-wise. **Tests must compare semantically (unmarshal both sides and compare structures), not byte-compare.** This is explicitly allowed by the spec.

- [ ] **Step 1: Add `gopkg.in/yaml.v3` to go.mod**

Run: `cd go && go get gopkg.in/yaml.v3`

- [ ] **Step 2: Write failing test — empty sites, http challenge**

```go
// go/internal/agent/traefik/config_test.go
package traefik

import (
	"testing"

	"github.com/plosson/siteio/internal/types"
	"gopkg.in/yaml.v3"
)

func TestGenerateDynamicConfig_EmptySites(t *testing.T) {
	cfg := Config{
		Domain:         "example.com",
		FileServerPort: 3000,
	}
	got := GenerateDynamicConfig(cfg, nil)
	var parsed map[string]any
	if err := yaml.Unmarshal([]byte(got), &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	http := parsed["http"].(map[string]any)
	routers := http["routers"].(map[string]any)
	if _, ok := routers["api-router"]; !ok {
		t.Error("expected api-router")
	}
	services := http["services"].(map[string]any)
	if _, ok := services["api-service"]; !ok {
		t.Error("expected api-service")
	}
	if _, ok := services["nginx-service"]; !ok {
		t.Error("expected nginx-service")
	}
}

func TestGenerateDynamicConfig_SiteWithOAuth(t *testing.T) {
	cfg := Config{
		Domain:         "example.com",
		FileServerPort: 3000,
		OAuthConfig: &types.AgentOAuthConfig{
			IssuerURL:    "https://accounts.google.com",
			ClientID:     "id",
			ClientSecret: "secret",
			CookieSecret: "cookie",
			CookieDomain: "example.com",
		},
	}
	sites := []types.SiteMetadata{
		{
			Subdomain: "restricted",
			OAuth:     &types.SiteOAuth{AllowedDomain: "example.com"},
		},
	}
	got := GenerateDynamicConfig(cfg, sites)
	// assert middlewares present and attached to site router
	// assert per-site logout-router exists
	_ = got
}
```

- [ ] **Step 3: Run (expect FAIL)**

- [ ] **Step 4: Implement `GenerateStaticConfig` + `GenerateDynamicConfig` + `GenerateNginxConfig`**

Port the logic from `traefik.ts:250-573` directly. Use stdlib `strings.Builder` for nginx config (it's hand-formatted text with specific comments and spacing — byte-exact is a reasonable target since nginx config is a regular grammar).

- [ ] **Step 5: Add tests**

Cases to cover:
- All three ACME challenge types in static config.
- Sites with custom domains (verify `site-<name>-cd-<i>` router naming).
- OAuth configured + site with `allowedEmails`, site with `allowedGroups`, site with `allowedDomain`.
- Sites with persistent storage → nginx config contains `sub_filter` block.
- OAuth configured with vs without `endSessionEndpoint` → logout URL differs.

- [ ] **Step 6: Run full suite**

Run: `cd go && go test ./internal/agent/traefik -count=1 -v`

- [ ] **Step 7: Commit**

```bash
git add go/internal/agent/traefik/ go/go.mod go/go.sum
git commit -m "feat(go): slice-1: port Traefik config generators"
```

### Task 1.3: Port `TraefikManager` — container orchestration

**Files:**
- Modify: `go/internal/agent/traefik/config.go` (add manager struct)
- Create: `go/internal/agent/traefik/manager.go`
- Create: `go/internal/agent/traefik/manager_test.go`
- Create: `go/internal/runner/runner.go` (shared shell-out interface)
- Create: `go/internal/runner/runner_test.go`
- Reference: `src/lib/agent/traefik.ts` (lines 175–240, 583–853, 981–994)

**Scope:** `Start`, `Stop`, `StartNginx`, `StopNginx`, `StartOAuthProxy`, `StopOAuthProxy`, `RestartOAuthProxy`, `ReloadNginx`, `WriteStaticConfig`, `UpdateDynamicConfig`, `UpdateNginxConfig`, `EnsureNetwork`, `GetRouterTlsStatus`, `GetAllRoutersTlsStatus`.

**Runner interface (defined once, used by traefik/docker/git/ssh wrappers):**

```go
// go/internal/runner/runner.go
package runner

import "os/exec"

type Runner interface {
	Run(name string, args ...string) (stdout []byte, stderr []byte, exitCode int, err error)
}

type Exec struct{}

func (e *Exec) Run(name string, args ...string) ([]byte, []byte, int, error) {
	cmd := exec.Command(name, args...)
	var so, se bytesBuffer
	cmd.Stdout = &so
	cmd.Stderr = &se
	err := cmd.Run()
	exit := 0
	if ee, ok := err.(*exec.ExitError); ok {
		exit = ee.ExitCode()
		err = nil // treat non-zero as exit, not error
	}
	return so.Bytes(), se.Bytes(), exit, err
}
```

**Test strategy:**
- Use a fake `Runner` that records invocations and returns canned output. Verify commands + args match what the TS code runs.
- Integration test (tagged `//go:build integration`) that actually starts a container — run only locally, not in CI.

- [ ] **Step 1: Implement `runner.Runner` interface + `Exec` impl + `Fake` for tests**

- [ ] **Step 2: Write test — `StartNginx` invokes docker with the expected args**

```go
func TestStartNginx_InvokesDockerRun(t *testing.T) {
	fake := &runner.Fake{}
	m := NewManager(Config{...}, fake)
	if err := m.StartNginx(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Assert the fake recorded a `docker run -d --name siteio-nginx ...` call
	// Assert the -v bind mounts include sitesDir and nginxConfigDir
}
```

- [ ] **Step 3: Implement `Manager.StartNginx`, `StopNginx`, `ReloadNginx`, `Start`, `Stop`, `StartOAuthProxy`, etc.**

Port one-for-one from `traefik.ts`.

- [ ] **Step 4: Write tests for each method using the fake runner**

Test that:
- `StartOAuthProxy` with no OAuth config is a no-op.
- `StartOAuthProxy` passes all expected `-e` flags.
- `EnsureNetwork` creates the network only if inspect fails.
- `Stop` stops nginx + oauth-proxy + traefik in that order.

- [ ] **Step 5: Port `GetRouterTlsStatus` + `GetAllRoutersTlsStatus`**

These hit Traefik's HTTP API on `127.0.0.1:8080`. Test with `httptest.Server` returning canned JSON.

Port `verifyActualCert` using `crypto/tls.Dial` with `InsecureSkipVerify: true`. Test with `httptest` TLS server returning a Let's Encrypt-issued cert (use a fixture cert).

- [ ] **Step 6: Run suite**

Run: `cd go && go test ./internal/agent/traefik ./internal/runner -count=1 -v`

- [ ] **Step 7: Commit**

```bash
git add go/internal/agent/traefik/ go/internal/runner/
git commit -m "feat(go): slice-1: port TraefikManager container orchestration"
```

### Task 1.4: Port `persistent-storage.ts` (used by sites)

**Files:**
- Create: `go/internal/agent/storage/persistent.go`
- Create: `go/internal/agent/storage/persistent_test.go`
- Reference: `src/lib/agent/persistent-storage.ts`

- [ ] **Step 1: Read `src/lib/agent/persistent-storage.ts`**

- [ ] **Step 2: Write failing tests covering the public surface** (the TS file is 61 lines — tests should cover every method)

- [ ] **Step 3: Implement**

- [ ] **Step 4: Commit**

```bash
git add go/internal/agent/storage/persistent.go go/internal/agent/storage/persistent_test.go
git commit -m "feat(go): slice-1: port PersistentStorageManager"
```

### Task 1.5: Scaffold `agent/server` HTTP dispatcher with auth

**Files:**
- Create: `go/internal/agent/server/server.go`
- Create: `go/internal/agent/server/server_test.go`
- Reference: `src/lib/agent/server.ts` (lines 26–160 — struct, constructor, auth, routing skeleton)

**Scope of this task:** just the shell — `Server` struct, `ServeHTTP` method, auth middleware, `/health`, `/oauth/status`. No site or app routes yet.

- [ ] **Step 1: Write failing test — `/health` returns `{"success":true,"data":{"status":"ok"}}`**

```go
func TestHealth(t *testing.T) {
	s := newTestServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "http://api.example.com/health", nil)
	s.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status: got %d", rec.Code)
	}
	var body map[string]any
	json.Unmarshal(rec.Body.Bytes(), &body)
	if body["success"] != true {
		t.Error("success not true")
	}
}
```

- [ ] **Step 2: Write failing test — unauthenticated request to `/sites` returns 401**

- [ ] **Step 3: Implement the server shell** — use stdlib `http.ServeMux` (1.22+ patterns) or a method-dispatch switch mirroring `server.ts:102-305`. The TS code uses manual regex matching on the URL path; Go 1.22 `ServeMux` with `GET /sites/{subdomain}` patterns is cleaner and equivalent.

- [ ] **Step 4: Implement auth check** (exact port of `checkAuth` — compare `X-API-Key` header to config value).

- [ ] **Step 5: Run (expect PASS)**

- [ ] **Step 6: Commit**

```bash
git add go/internal/agent/server/
git commit -m "feat(go): slice-1: scaffold agent server with auth + /health + /oauth/status"
```

### Task 1.6: Port `/auth/check` endpoint (used by Traefik forwardAuth)

**Files:**
- Modify: `go/internal/agent/server/server.go`
- Modify: `go/internal/agent/server/server_test.go`
- Reference: `src/lib/agent/server.ts` — search for `handleAuthCheck`. Read that method and its group + oauth dependencies.

- [ ] **Step 1: Read the full `handleAuthCheck` implementation in `server.ts`**

- [ ] **Step 2: Write tests** — cases: no OAuth configured returns 200; site with `allowedEmails` including header email returns 200; site with `allowedDomain` matching email domain returns 200; mismatched email returns 401; `allowedGroups` lookup through `GroupStorage`.

- [ ] **Step 3: Implement `handleAuthCheck`**

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(go): slice-1: port /auth/check endpoint"
```

### Task 1.7: Port `/sites` GET (list) endpoint

**Files:**
- Modify: `go/internal/agent/server/server.go`
- Modify: `go/internal/agent/server/server_test.go`
- Reference: `src/lib/agent/server.ts:163-165` → `handleListSites:307-325`

- [ ] **Step 1: Write test** — two sites in storage, `GET /sites` with valid auth returns both with correct `url`, `tls` populated from traefik mock.

- [ ] **Step 2: Implement handler** — delegate to `SiteStorage.ListSites`, fetch TLS status from `TraefikManager.GetAllRoutersTlsStatus`.

- [ ] **Step 3: Commit**

```bash
git commit -am "feat(go): slice-1: port GET /sites"
```

### Task 1.8: Port `POST /sites/:subdomain` (deploy)

**Files:**
- Modify: `go/internal/agent/server/server.go`
- Modify: `go/internal/agent/server/server_test.go`
- Reference: `src/lib/agent/server.ts:168-171` → `handleDeploy:327-426`

**Behavioral contract (do not cleanup while porting):**
- Validates subdomain regex `^[a-z0-9-]+$`.
- Rejects reserved `api` subdomain.
- Requires `Content-Type: application/zip`.
- Rejects if `Content-Length > maxUploadSize`.
- Optimistic concurrency via `X-Expected-Version` header — returns 409 with exact TS error string on mismatch.
- Reads OAuth headers `X-Site-OAuth-Emails` / `X-Site-OAuth-Domain`, rejects if OAuth not configured with exact TS error message.
- Reads `X-Deployed-By`, `X-Site-Persistent-Storage`.

- [ ] **Step 1: Write tests** for each failure mode + happy path + 409 concurrency case.

- [ ] **Step 2: Implement** by reading `handleDeploy` line-for-line.

- [ ] **Step 3: Commit**

```bash
git commit -am "feat(go): slice-1: port POST /sites/:subdomain (deploy)"
```

### Task 1.9: Port remaining site endpoints

**Files:** same as above.

Port one endpoint per sub-task, same pattern (test → implement → commit):

- [ ] **1.9.1** `DELETE /sites/:subdomain` (undeploy) — ref `server.ts:428-445`
- [ ] **1.9.2** `GET /sites/:subdomain/download` — ref `server.ts:447-470`
- [ ] **1.9.3** `PATCH /sites/:subdomain/auth` — ref `server.ts:472-526`
- [ ] **1.9.4** `PATCH /sites/:subdomain/domains` — ref `server.ts:528-606` (includes conflict checks against sites + apps — apps can be a stub returning empty for now if Slice 2 hasn't shipped)
- [ ] **1.9.5** `PATCH /sites/:subdomain/rename` — ref `server.ts:608-662`
- [ ] **1.9.6** `GET /sites/:subdomain/history` — ref `server.ts:664-671`
- [ ] **1.9.7** `POST /sites/:subdomain/rollback` — ref `server.ts:673-710` (read the full method)
- [ ] **1.9.8** `PATCH /sites/:subdomain/storage` (persistent storage toggle)
- [ ] **1.9.9** `/__storage/*` endpoints (shim.js, get/put storage) — ref `server.ts:116-126` + handler methods

Each commit: `feat(go): slice-1: port <endpoint>`.

### Task 1.10: Wire the Go agent into `cmd/siteio agent start-go`

**Files:**
- Create: `go/internal/cli/agent/start.go` (stub — full agent CLI is Slice 5, but we need a way to run the Go agent now)
- Modify: `go/cmd/siteio/main.go` to wire cobra + one subcommand `agent start-go`

- [ ] **Step 1: Add cobra dependency**

Run: `cd go && go get github.com/spf13/cobra@latest`

- [ ] **Step 2: Create a minimal cobra root with `agent start-go`**

```go
// go/cmd/siteio/main.go
package main

import (
	"log/slog"
	"os"

	"github.com/spf13/cobra"
)

var version = "dev"

func main() {
	root := &cobra.Command{
		Use:     "siteio",
		Version: version,
	}
	root.AddCommand(agentCmd())
	if err := root.Execute(); err != nil {
		slog.Error("command failed", "error", err)
		os.Exit(1)
	}
}
```

```go
// go/internal/cli/agent/start.go (or inline in main package for now)
func agentStartCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "start-go",
		Short: "Start the Go agent (parity-testing mode)",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg := loadAgentConfigFromEnv()
			srv := server.New(cfg)
			return srv.ListenAndServe()
		},
	}
}
```

- [ ] **Step 3: Build and smoke-test**

Run: `cd go && go build ./cmd/siteio`. Start with `SITEIO_DOMAIN=... SITEIO_API_KEY=... SITEIO_DATA_DIR=/tmp/siteio-test SITEIO_SKIP_TRAEFIK=1 ./siteio agent start-go`. Hit `/health`.

- [ ] **Step 4: Parity smoke test against running TS CLI**

With the Go agent running locally, configure the TS CLI to point at it (`siteio login --api-url http://localhost:PORT --api-key ...`) and run `siteio sites list`, `siteio sites deploy ./examples/static`, etc. All site commands should succeed.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(go): slice-1: wire agent start-go subcommand; parity-tested with TS CLI"
```

### Task 1.11: Slice 1 closeout — integration tests + cross-binary smoke test

- [ ] **Step 1: Add a CI integration job** that runs the Go agent in `skipTraefik` mode and exercises it with the TS CLI (or equivalent).

- [ ] **Step 2: Fix any issues surfaced by parity testing.**

- [ ] **Step 3: Tag an internal milestone commit**

```bash
git commit --allow-empty -m "chore(go): slice-1 complete: sites + traefik on Go agent"
```

---

## Slice 2 — Agent: apps lifecycle

**Outcome:** Go agent handles the full app lifecycle (create, get, update, delete, deploy, stop, restart, logs) including image-based, git-based, inline-dockerfile-based, and compose-based apps. TS CLI exercises all of it successfully.

### Task 2.1: Port `AppStorage` (`src/lib/agent/app-storage.ts` → `go/internal/agent/storage/apps.go`)

**Reference:** `src/lib/agent/app-storage.ts` (158 lines, already reviewed).

**Behavioral contract:**
- Validates app name regex `^[a-z0-9-]+$`, rejects reserved name `"api"`, rejects empty.
- `Create` fails if app already exists with exact TS error string.
- `Update` merges env vars additively (not replacement); `unsetEnv` removes keys.
- `Update` preserves `name` + `createdAt`, refreshes `updatedAt`.
- `ToInfo(app, domain)` formats the outbound `AppInfo`.
- `CreateStaticSiteApp(name, sitePath, oauth)` — creates the nginx-backed static site wrapper.

- [ ] **Step 1–N:** Same pattern as Task 1.1. Write failing tests (table-driven on name validation; env-merge test with both set + unset; round-trip test against a fixture `apps.json`), implement, verify, commit.

Commit: `feat(go): slice-2: port AppStorage`.

### Task 2.2: Port `DockerfileStorage` + `ComposeStorage`

**Files:**
- Create: `go/internal/agent/storage/dockerfile.go`
- Create: `go/internal/agent/storage/compose.go`
- Tests for each.
- Reference: `src/lib/agent/dockerfile-storage.ts` (58 lines), `src/lib/agent/compose-storage.ts` (70 lines)

These are small storage wrappers (file upload → `$DATA/apps/dockerfiles/<name>` and `$DATA/apps/compose/<name>/`). Straightforward port.

Commit: `feat(go): slice-2: port DockerfileStorage + ComposeStorage`.

### Task 2.3: Port `git.ts` → `go/internal/agent/git/git.go`

**Files:**
- Create: `go/internal/agent/git/git.go`
- Create: `go/internal/agent/git/git_test.go`
- Reference: `src/lib/agent/git.ts` (140 lines)

**Behavioral contract:**
- `Clone(repoURL, branch, targetDir, token?)` — shells out to `git clone`. When `token` is present, use `GIT_ASKPASS` shim to inject it for HTTPS.
- `Pull(targetDir, branch)`, `GetCommitHash(targetDir)`.

**Test strategy:**
- Unit tests with `Fake` runner verifying exact `git` argv.
- One integration test (`//go:build integration`) that clones a tiny public repo into a temp dir.
- Test that `GIT_ASKPASS` shim is written to a temp file with mode `0700`, cleaned up after.

Commit: `feat(go): slice-2: port git wrapper with GIT_ASKPASS token support`.

### Task 2.4: Port `docker.ts` → `go/internal/agent/docker/docker.go`

**Files:**
- Create: `go/internal/agent/docker/docker.go`
- Create: `go/internal/agent/docker/docker_test.go`
- Reference: `src/lib/agent/docker.ts` (410 lines)

**Behavioral contract (enumerate from the TS file):**
- `Pull(image)`, `Build(context, dockerfile, tag, noCache, buildArgs?)`, `Run(opts RunOptions)`, `Stop(name)`, `Rm(name, force)`, `Logs(name, tail, follow) io.ReadCloser`, `Inspect(name) (ContainerInspect, error)`, `ContainerExists(name) bool`, `ContainerRunning(name) bool`.
- `RunOptions` carries: image, name, env, volumes, restartPolicy, domains (for Traefik labels), internalPort, network (`siteio-network`), extraHosts, primaryService (compose).
- Network creation / ensurement if not already handled by TraefikManager.

**Test strategy:**
- Unit tests with `Fake` runner verifying the full `docker run` argv for each representative config.
- Integration tests (`//go:build integration`) that actually invoke docker — skipped in CI.

Decompose into sub-tasks if it grows — one per public method. Commit per method or per logical group (shell-outs for build vs run vs inspect).

Commit: `feat(go): slice-2: port DockerManager`.

### Task 2.5: Port `compose.ts` + `compose-override.ts`

**Files:**
- Create: `go/internal/agent/compose/compose.go`
- Create: `go/internal/agent/compose/override.go`
- Create: `go/internal/agent/compose/override_test.go`
- Reference: `src/lib/agent/compose.ts` (167 lines), `src/lib/agent/compose-override.ts` (112 lines)

**Scope:**
- `compose.go` — invoke `docker compose` subcommands (up, down, logs, ps). Same Runner pattern.
- `override.go` — given a compose file path + app config, emit a `docker-compose.override.yml` that:
  - Binds the primary service to `siteio-network`
  - Injects Traefik labels for routing + optional OAuth middleware
  - Applies env vars / volumes from app config
  - Tests from `compose-override.test.ts` if it exists; otherwise construct from behavior observed in `override.ts`.

**Test strategy:**
- For `override.go`: parse generated YAML, assert structure.
- For `compose.go`: fake runner verifies argv.

Commit: `feat(go): slice-2: port compose support (override + orchestration)`.

### Task 2.6: Port the apps HTTP endpoints

**Files:**
- Modify: `go/internal/agent/server/server.go` + tests
- Reference: `src/lib/agent/server.ts:252-305` + handler methods `handleListApps`, `handleCreateApp`, `handleGetApp`, `handleUpdateApp`, `handleDeleteApp`, `handleDeployApp`, `handleStopApp`, `handleRestartApp`, `handleGetAppLogs` (read these methods in `server.ts`; they are the behavioral spec)

Port one endpoint per sub-task following Task 1.8's pattern:

- [ ] **2.6.1** `GET /apps` (list)
- [ ] **2.6.2** `POST /apps` (create — includes exclusivity checks between `image`/`git`/`dockerfile`/`compose`)
- [ ] **2.6.3** `GET /apps/:name` (get)
- [ ] **2.6.4** `PATCH /apps/:name` (update — handles env merge, `unsetEnv`, git token clear semantics)
- [ ] **2.6.5** `DELETE /apps/:name` (delete — stops container, removes config)
- [ ] **2.6.6** `POST /apps/:name/deploy` (deploy — largest handler; handles image pull, git clone/pull, dockerfile build, compose up)
- [ ] **2.6.7** `POST /apps/:name/stop`
- [ ] **2.6.8** `POST /apps/:name/restart`
- [ ] **2.6.9** `GET /apps/:name/logs` (streaming — use `http.ResponseWriter.Flush()` + chunked transfer encoding)
- [ ] **2.6.10** Dockerfile upload endpoint (if separate path — check `server.ts`)
- [ ] **2.6.11** Compose file + env file upload endpoints

**Critical test for deploy:** exercise all four source types (image, git, inline-dockerfile, compose-inline, compose-git) with a fake runner and assert the correct sequence of docker/git commands executes.

Each commit: `feat(go): slice-2: port <endpoint>`.

### Task 2.7: Slice 2 closeout — parity smoke test

- [ ] **Step 1:** With Go agent running, exercise `siteio apps create/deploy/logs/stop/rm` from TS CLI for each source type. All should succeed.

- [ ] **Step 2:** Tag milestone commit.

```bash
git commit --allow-empty -m "chore(go): slice-2 complete: apps lifecycle on Go agent"
```

---

## Slice 3 — Agent: groups, OAuth, admin UI

**Outcome:** Go agent is feature-complete for the TS CLI. Ship as `v2.0.0-alpha`. Swap the binary on the production server and verify zero behavior change.

### Task 3.1: Port `GroupStorage`

**Files:**
- Create: `go/internal/agent/groups/groups.go`
- Create: `go/internal/agent/groups/groups_test.go`
- Reference: `src/lib/agent/groups.ts` (128 lines)

Standard pattern. TDD.

Commit: `feat(go): slice-3: port GroupStorage`.

### Task 3.2: Port group HTTP endpoints

Endpoints (from `server.ts:220-250`):
- `GET /groups` (list)
- `POST /groups` (create)
- `GET /groups/:name`
- `PUT /groups/:name` (replace)
- `DELETE /groups/:name`
- `PATCH /groups/:name/emails` (add/remove)

One commit per endpoint.

### Task 3.3: Port OAuth config loading + OIDC discovery

**Files:**
- Create: `go/internal/agent/oauth/config.go`
- Create: `go/internal/agent/oauth/discovery.go`
- Tests for each.
- Reference: `src/config/oauth.ts` (83 lines), `src/config/oidc-discovery.ts` (44 lines)

**Behavioral contract:**
- `LoadOAuthConfig(dataDir)` reads `$DATA/oauth.json` → `AgentOAuthConfig` or nil.
- `SaveOAuthConfig(dataDir, cfg)` writes same file.
- `DiscoverOIDC(issuerURL) (endpoints, error)` — HTTP GET on `<issuer>/.well-known/openid-configuration`, extracts `end_session_endpoint`.
- `EnsureDiscoveredConfig(cfg) (updatedCfg, mutated bool, error)` — runs discovery if not done recently, caches `discoveredAt`.

**Test strategy:**
- Use `httptest.Server` to stub the OIDC discovery endpoint.
- Verify `end_session_endpoint` is stored or absent (Google case).

Commit: `feat(go): slice-3: port OAuth config + OIDC discovery`.

### Task 3.4: Port admin UI via `embed.FS`

**Files:**
- Move or copy: admin UI HTML/CSS/JS source files into `go/internal/agent/ui/assets/`
- Create: `go/internal/agent/ui/ui.go` with `//go:embed assets/*` directive
- Reference: `src/lib/agent/ui/assets.ts` (11 lines — reads/embeds bundled HTML/CSS/JS; trace back to the source files)

**Scope:**
- Embed `index.html`, `app.js`, `styles.css` (or whatever the admin UI ships today).
- Serve from the server's route handlers matching the TS behavior (check `Bun.serve` routes map in `server.ts` — look for `/ui`, `/ui/app.js`, etc.).

- [ ] **Step 1:** Identify the admin UI source files in the TS tree. Check the `2026-04-20-admin-ui-design.md` plan and `src/lib/agent/ui/assets.ts`.
- [ ] **Step 2:** Copy to `go/internal/agent/ui/assets/`.
- [ ] **Step 3:** Add `embed.FS` + route handlers in `server.go`.
- [ ] **Step 4:** Test `GET /ui/` returns HTML with `Content-Type: text/html`.
- [ ] **Step 5:** Commit.

Commit: `feat(go): slice-3: embed admin UI assets`.

### Task 3.5: Slice 3 closeout — ship `v2.0.0-alpha`

- [ ] **Step 1:** Build the Go binary for linux/amd64.

Run: `cd go && GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w -X main.version=2.0.0-alpha" -o /tmp/siteio-go ./cmd/siteio`

- [ ] **Step 2:** Verify binary size.

Run: `ls -lh /tmp/siteio-go`. **Expected: ≤ 20 MB.** If materially larger, investigate (most likely: an unwanted import tree — use `go tool nm -size` or `go mod why`).

- [ ] **Step 3:** `scp` the binary to the production server, stop the TS agent, start the Go agent (with `skipTraefik=false`), verify existing sites/apps continue serving.

- [ ] **Step 4:** Roll back to TS binary after the test — `v2.0.0-alpha` isn't an official release, just a parity check.

- [ ] **Step 5:** Record the binary size and any surprises. Commit a note to the spec's "Risks" section if needed.

- [ ] **Step 6:** Tag milestone commit.

```bash
git commit --allow-empty -m "chore(go): slice-3 complete: agent feature-complete, alpha-tested on prod server"
```

---

## Slice 4 — CLI: sites, apps, login, status, config

**Outcome:** Go CLI can drive the Go agent for all daily-use commands. TS CLI is no longer necessary for these paths.

### Task 4.1: Port `src/lib/client.ts` → `go/internal/client/client.go`

**Reference:** `src/lib/client.ts` (437 lines).

This is the HTTP client layer used by every CLI command. Methods map 1:1 to the agent endpoints ported in Slices 1–3.

**Behavioral contract:**
- Constructor takes `apiURL, apiKey`.
- Methods return typed results + error.
- Preserves exact TS request bodies + header names.
- Translates non-2xx responses to `APIError` with server's error message.

**Test strategy:**
- `httptest.Server` that returns canned responses; assert client serializes requests correctly and parses responses.
- Table-driven.

Decompose into sub-tasks by method group (sites methods, apps methods, groups methods, auth methods).

Commit: `feat(go): slice-4: port Client HTTP wrapper`.

### Task 4.2: Port `src/utils/token.ts`, `src/utils/site-config.ts`, `src/utils/ssh.ts` (shared utilities)

One TDD cycle per file. Commits: `feat(go): slice-4: port <utility>`.

### Task 4.3: Port `src/config/loader.ts` (client config)

**Reference:** `src/config/loader.ts`.

**Behavioral contract:**
- Loads `~/.config/siteio/config.json` → `ClientConfig`.
- Migrates legacy `{apiUrl, apiKey}` top-level fields into `servers` map.
- Handles missing file (returns empty config).
- `SaveConfig`, `SetCurrent`, `AddServer`, `RemoveServer`.

TDD with temp HOME dir.

Commit: `feat(go): slice-4: port client config loader with legacy migration`.

### Task 4.4: Port `src/utils/output.ts` + `src/utils/prompt.ts` (if not done in Slice 0)

Refine/extend the Slice 0 port. `prompt.ts` is interactive — port carefully; use `github.com/charmbracelet/huh` or stay stdlib with a simple `bufio.Scanner`-based prompt (stdlib preferred for binary size).

Commit: `feat(go): slice-4: port prompt/output utilities`.

### Task 4.5: Port site commands (`src/commands/sites/*.ts`)

One sub-task per command file:

- [ ] **4.5.1** `deploy.ts` → `go/internal/cli/sites/deploy.go` — zips folder, uploads to agent. Use stdlib `archive/zip`.
- [ ] **4.5.2** `list.ts` → `list.go`
- [ ] **4.5.3** `info.ts` → `info.go`
- [ ] **4.5.4** `download.ts` → `download.go`
- [ ] **4.5.5** `rm.ts` → `rm.go`
- [ ] **4.5.6** `history.ts` → `history.go`
- [ ] **4.5.7** `rollback.ts` → `rollback.go`
- [ ] **4.5.8** `auth.ts` → `auth.go`
- [ ] **4.5.9** `rename.ts` → `rename.go`
- [ ] **4.5.10** `domain.ts` → `domain.go`
- [ ] **4.5.11** `set.ts` → `set.go`

Each command is a cobra `*cobra.Command` factory. Wire into the CLI tree in `cmd/siteio/main.go`.

Test each with a fake `Client` (inject via cobra command context or package-level var with a test hook).

Commit per file: `feat(go): slice-4: port sites <cmd>`.

### Task 4.6: Port app commands (`src/commands/apps/*.ts`)

Same pattern, one per file:

- [ ] **4.6.1** `create.ts` → `create.go` (handles `--image`, `--git`, `--file`, `--compose-file`, `--compose`, `--service`, `--env-file`, `--branch`, `--context`, `--git-token`, `--port`, `--dockerfile`)
- [ ] **4.6.2** `list.ts`
- [ ] **4.6.3** `info.ts`
- [ ] **4.6.4** `deploy.ts` — note the commander `--no-cache` boolean translation quirk documented in `src/cli.ts:287-296`; reproduce the same flag semantics in cobra.
- [ ] **4.6.5** `stop.ts`, `restart.ts`
- [ ] **4.6.6** `rm.ts` (with `--force`, `--yes`)
- [ ] **4.6.7** `logs.ts` (streaming; pipe directly to stdout)
- [ ] **4.6.8** `set.ts` (-e, -v, -d, -p, -r, --image, --dockerfile, --git-token)
- [ ] **4.6.9** `unset.ts`

Commit per file.

### Task 4.7: Port `login`, `logout`, `status`, `config`

- [ ] `src/commands/login.ts` → `go/internal/cli/login.go`
- [ ] `src/commands/logout.ts` → `logout.go`
- [ ] `src/commands/status.ts` → `status.go`
- [ ] `src/commands/config.ts` → `config.go`

TDD against fake config filesystem.

Commit per command.

### Task 4.8: Wire everything into `cmd/siteio/main.go`

Build the full cobra tree matching `src/cli.ts`:
- Root: `siteio`, global `--json` flag.
- `siteio status`, `siteio config set/get`, `siteio login`, `siteio logout`.
- `siteio sites deploy/list/info/download/rm/history/rollback/auth/rename/domain add/remove/list/set`.
- `siteio apps create/list/info/deploy/stop/restart/rm/logs/set/unset`.
- `siteio groups list/show/create/delete/add/remove`.
- `siteio agent start-go` still present (parity mode).

- [ ] **Step 1:** Read `src/cli.ts` line by line; each `program.command(...)` becomes a cobra command factory.
- [ ] **Step 2:** Verify output of `./siteio --help` matches TS `siteio --help` (structurally — descriptions may differ slightly; keep them the same where easy).

Commit: `feat(go): slice-4: wire full cobra command tree`.

### Task 4.9: Slice 4 closeout — dogfood the Go CLI

- [ ] **Step 1:** Install the Go binary to `~/.local/bin/siteio-go`.
- [ ] **Step 2:** Use it for all daily work for ≥ 1 day; file issues for any parity gap.
- [ ] **Step 3:** Fix gaps.
- [ ] **Step 4:** Tag milestone.

```bash
git commit --allow-empty -m "chore(go): slice-4 complete: CLI daily-use paths on Go"
```

---

## Slice 5 — CLI: groups, skill, remote-agent, completion, update

**Outcome:** Go CLI is feature-complete. Everything the TS CLI does, the Go CLI does.

### Task 5.1: Port `groups` commands

- [ ] `src/commands/groups.ts` (202 lines; 7 subcommands) → `go/internal/cli/groups/*.go`

One commit per subcommand (list, show, create, delete, add, remove).

### Task 5.2: Port `skill` commands

**Files:**
- `src/commands/skill.ts` (81 lines) → `go/internal/cli/skill.go`
- `src/lib/skill-content.ts` (79 lines — skill file content) → `go/internal/cli/skill_content.go` (or embed skill `.md` files via `embed.FS`)

Commit: `feat(go): slice-5: port skill install/uninstall`.

### Task 5.3: Port agent commands (local)

- [ ] `src/commands/agent/start.ts` → `go/internal/cli/agent/start.go` (replaces the `start-go` parity subcommand — this is the final `siteio agent start`)
- [ ] `src/commands/agent/stop.ts` → `stop.go`
- [ ] `src/commands/agent/restart.ts` → `restart.go`
- [ ] `src/commands/agent/status.ts` → `status.go`
- [ ] `src/commands/agent/config.ts` → `config.go` (list/get/set/unset)
- [ ] `src/commands/agent/oauth.ts` → `oauth.go`

Commit per subcommand.

### Task 5.4: Port agent install/uninstall (local + remote SSH)

**Files:**
- `src/commands/agent/install.ts` (637 lines — largest single file) → split into:
  - `go/internal/cli/agent/install.go` (entry, dispatches local vs remote)
  - `go/internal/cli/agent/install_local.go`
  - `go/internal/cli/agent/install_remote.go` (SSH shell-out)
  - `go/internal/cli/agent/bootstrap.go` (docker install, systemd unit generation)
- `src/commands/agent/uninstall.ts` (364 lines) → equivalent split.
- `src/lib/cloudflare.ts` (287 lines) → `go/internal/cli/cloudflare/cloudflare.go` (for `--cloudflare-token` DNS setup)
- `src/lib/verification.ts` (163 lines) → `go/internal/cli/verification/verification.go` (DNS/cert verification after install)

**Test strategy:**
- Split the monolithic install flow into functions (detect target, bootstrap docker, install binary, generate systemd unit, configure Traefik). Each gets unit tests against a fake runner.
- End-to-end integration test is manual: run `siteio agent install --domain ...` against a throwaway VM.

This is the densest port in Slice 5. Plan 2–3 commits: one for the split refactor (pure structure, no new logic), then port each sub-function.

Commits:
- `feat(go): slice-5: split install into detect/bootstrap/configure`
- `feat(go): slice-5: port install local path`
- `feat(go): slice-5: port install remote (SSH) path`
- `feat(go): slice-5: port cloudflare DNS helper`
- `feat(go): slice-5: port uninstall`

### Task 5.5: Port `completion` command (replace with cobra built-in)

Cobra generates `completion bash/zsh/fish` automatically. The interactive wizard (hand-rolled in `src/commands/completion.ts`, 316 lines) needs to wrap cobra's output or invoke the same setup logic (detecting shell, writing to the correct rc file).

- [ ] **Step 1:** Keep the interactive UX — port the shell detection + write logic.
- [ ] **Step 2:** For "output script", delegate to cobra's `GenBashCompletion`/`GenZshCompletion`/`GenFishCompletion`.

Commit: `feat(go): slice-5: port completion command (cobra-backed)`.

### Task 5.6: Port `update` command

**Files:**
- `src/commands/update.ts` (335 lines) → `go/internal/cli/update.go`

**Behavioral contract:**
- Check GitHub releases for latest tag.
- Download the appropriate asset (`siteio-linux-amd64`, etc.).
- Verify (sha256, signature if present).
- Replace the running binary atomically (`rename` pattern).
- Offer `--check`, `--force`, `-y`.

Tests with fake HTTP server for GitHub API.

Commit: `feat(go): slice-5: port update command`.

### Task 5.7: Slice 5 closeout — full parity check

- [ ] **Step 1:** Run `siteio --help` against both TS and Go binaries; diff and reconcile.
- [ ] **Step 2:** Run each command in a throwaway account end-to-end (create a new VM, `install`, deploy a site, deploy an app, oauth, cloudflare, uninstall).
- [ ] **Step 3:** Tag milestone.

```bash
git commit --allow-empty -m "chore(go): slice-5 complete: CLI feature-complete"
```

---

## Slice 6 — Cutover

**Outcome:** Go binary is the shipped product. TS tree is deleted. Release pipeline builds Go.

### Task 6.1: Update release workflow

**Files:**
- Modify: `.github/workflows/release.yml` (or equivalent — read current file first)

- [ ] **Step 1:** Read the current release workflow.
- [ ] **Step 2:** Replace the Bun compile step with Go builds for each target:

```yaml
      - uses: actions/setup-go@v5
        with:
          go-version: '1.25'
      - name: Build linux-amd64
        run: cd go && GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w -X main.version=${{ github.ref_name }}" -o ../dist/siteio-linux-amd64 ./cmd/siteio
      - name: Build linux-arm64
        run: cd go && GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w -X main.version=${{ github.ref_name }}" -o ../dist/siteio-linux-arm64 ./cmd/siteio
      - name: Build darwin-amd64
        run: cd go && GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags="-s -w -X main.version=${{ github.ref_name }}" -o ../dist/siteio-darwin-amd64 ./cmd/siteio
      - name: Build darwin-arm64
        run: cd go && GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="-s -w -X main.version=${{ github.ref_name }}" -o ../dist/siteio-darwin-arm64 ./cmd/siteio
```

- [ ] **Step 3:** Keep asset names identical to what current `siteio-linux-amd64` etc. produce (check TS `src/commands/update.ts` for the exact naming convention it fetches).

- [ ] **Step 4:** Commit.

```bash
git commit -am "ci: slice-6: build Go binaries in release workflow"
```

### Task 6.2: Update README, install script, docs

- [ ] Remove Bun-specific install instructions.
- [ ] Keep user-facing commands unchanged (they're preserved by the port).
- [ ] Mention `v2.0.0` is a Go rewrite in CHANGELOG (if one exists).

Commit: `docs: slice-6: document Go rewrite in v2.0.0`.

### Task 6.3: Publish a final TS release as `v1.99.0` (transition version)

This release's only purpose: ship the version of `update.ts` that knows how to fetch the Go binary. (If the current `update.ts` already fetches by filename from the GitHub release, no changes needed — assets are same names.)

- [ ] **Step 1:** Verify current `src/commands/update.ts` fetches by filename from GitHub releases.
- [ ] **Step 2:** If it hard-codes any runtime-specific logic (Bun's `compile:` protocol etc.), patch.
- [ ] **Step 3:** Bump `package.json` to `1.99.0`. Commit + tag + push. Verify Actions produces the release.

```bash
git commit -am "chore: slice-6: final TS release (v1.99.0) — Go transition"
git tag v1.99.0 && git push origin v1.99.0
```

### Task 6.4: Delete the TS tree

**Files:**
- Delete: `src/`, `bun.lock`, `tsconfig.json`, `globals.d.ts`, `playwright.config.ts`, `tests/playwright/`, `node_modules/`
- Modify: `package.json` — either delete entirely or strip to a minimal marker
- Modify: `.github/workflows/ci.yml` — remove Bun jobs
- Modify: `.gitignore` — remove Node-specific entries

- [ ] **Step 1:** Confirm Go binary runs end-to-end (sanity re-check).
- [ ] **Step 2:** `git rm -r src/ bun.lock tsconfig.json globals.d.ts playwright.config.ts tests/playwright/`
- [ ] **Step 3:** Edit/delete `package.json` and CI files.
- [ ] **Step 4:** Verify `go build ./cmd/siteio` still succeeds (nothing under `go/` depended on `src/`).
- [ ] **Step 5:** Commit.

```bash
git commit -am "chore: slice-6: delete TypeScript sources after Go cutover"
```

### Task 6.5: Tag `v2.0.0` and verify release

- [ ] **Step 1:** Bump version in `go/cmd/siteio/main.go` (or just rely on ldflags from the tag).
- [ ] **Step 2:** `git tag v2.0.0 && git push origin v2.0.0`.
- [ ] **Step 3:** Watch GitHub Actions build and publish assets.
- [ ] **Step 4:** Download `siteio-linux-amd64`, verify `ls -lh` ≤ 20 MB.
- [ ] **Step 5:** Update the production server:

```bash
ssh siteio "/root/.local/bin/siteio update -y && /root/.local/bin/siteio agent restart"
```

- [ ] **Step 6:** Verify existing sites + apps still serve correctly.

### Task 6.6: Post-cutover cleanup

- [ ] Delete feature flag / `start-go` parity subcommand if still present.
- [ ] Squash any TODO comments left in Go code.
- [ ] Update the brand/README with the new binary size fact.

Commit: `chore: slice-6: post-cutover cleanup`.

---

## Self-Review Checklist (run after each slice)

- [ ] All tests pass: `cd go && go test ./... -count=1`.
- [ ] Vet is clean: `cd go && go vet ./...`.
- [ ] No TS code imports Go symbols or vice versa.
- [ ] CI green on main.
- [ ] Spec's success criteria still achievable (revisit if binary size or behavior drifts).

---

## Appendix A — TS source files to port (inventory)

For reference while executing. Each file must be ported in the slice indicated.

| TS file | LOC | Slice | Target Go package |
|---|---|---|---|
| `src/types.ts` | 283 | 0 | `internal/types` |
| `src/utils/errors.ts` | 53 | 0 | `internal/errors` |
| `src/utils/output.ts` | 108 | 0 | `internal/output` |
| `src/lib/agent/storage.ts` | 404 | 1 | `internal/agent/storage` (sites) |
| `src/lib/agent/persistent-storage.ts` | 61 | 1 | `internal/agent/storage/persistent` |
| `src/lib/agent/traefik.ts` | 994 | 1 | `internal/agent/traefik` |
| `src/lib/agent/runtime.ts` | 59 | 1 | `internal/agent/runtime` |
| `src/lib/agent/storage-shim.ts` | 35 | 1 | `internal/agent/storage/shim` |
| `src/lib/agent/server.ts` (sites routes) | ~700 | 1 | `internal/agent/server` |
| `src/lib/agent/app-storage.ts` | 158 | 2 | `internal/agent/storage/apps` |
| `src/lib/agent/docker.ts` | 410 | 2 | `internal/agent/docker` |
| `src/lib/agent/git.ts` | 140 | 2 | `internal/agent/git` |
| `src/lib/agent/dockerfile-storage.ts` | 58 | 2 | `internal/agent/storage/dockerfile` |
| `src/lib/agent/compose-storage.ts` | 70 | 2 | `internal/agent/storage/compose` |
| `src/lib/agent/compose.ts` | 167 | 2 | `internal/agent/compose` |
| `src/lib/agent/compose-override.ts` | 112 | 2 | `internal/agent/compose/override` |
| `src/lib/agent/server.ts` (apps routes) | ~500 | 2 | `internal/agent/server` |
| `src/lib/agent/groups.ts` | 128 | 3 | `internal/agent/groups` |
| `src/config/oauth.ts` | 83 | 3 | `internal/agent/oauth` |
| `src/config/oidc-discovery.ts` | 44 | 3 | `internal/agent/oauth` |
| `src/lib/agent/ui/assets.ts` | 11 | 3 | `internal/agent/ui` |
| `src/lib/agent/server.ts` (groups/oauth/ui routes) | ~400 | 3 | `internal/agent/server` |
| `src/lib/client.ts` | 437 | 4 | `internal/client` |
| `src/config/loader.ts` | ? | 4 | `internal/config` |
| `src/utils/token.ts` | 79 | 4 | `internal/utils/token` |
| `src/utils/site-config.ts` | 62 | 4 | `internal/utils/siteconfig` |
| `src/utils/prompt.ts` | 65 | 4 | `internal/utils/prompt` |
| `src/commands/sites/*.ts` (11 files) | ~1.4k | 4 | `internal/cli/sites` |
| `src/commands/apps/*.ts` (10 files) | ~1.3k | 4 | `internal/cli/apps` |
| `src/commands/login.ts`, `logout.ts`, `status.ts`, `config.ts` | ~360 | 4 | `internal/cli` |
| `src/commands/groups.ts` | 202 | 5 | `internal/cli/groups` |
| `src/commands/skill.ts` | 81 | 5 | `internal/cli/skill` |
| `src/lib/skill-content.ts` | 79 | 5 | `internal/cli/skill` |
| `src/commands/agent/*.ts` (8 files) | ~1.6k | 5 | `internal/cli/agent` |
| `src/lib/cloudflare.ts` | 287 | 5 | `internal/cli/cloudflare` |
| `src/lib/verification.ts` | 163 | 5 | `internal/cli/verification` |
| `src/utils/ssh.ts` | 65 | 5 | `internal/utils/ssh` |
| `src/commands/completion.ts` | 316 | 5 | `internal/cli/completion` |
| `src/commands/update.ts` | 335 | 5 | `internal/cli/update` |
| `src/cli.ts` | 596 | 4–5 | `cmd/siteio/main.go` |

Grand total: ~15k TS lines ported. Expected Go LoC is typically 1.3–1.6× the TS (more verbose types, less terse syntax) — budget ~20–25k Go lines.

---

## Appendix B — Test data fixtures

Commit these to `go/testdata/` once obtained (sanitized):

- `live-snapshot/metadata/*.json` — real site metadata samples
- `live-snapshot/apps/apps.json` — real apps structure
- `live-snapshot/groups.json` — groups format
- `live-snapshot/oauth.json` — OIDC config (with secrets redacted to `REDACTED_*`)
- `live-snapshot/traefik/dynamic.yml` — reference Traefik dynamic config (for semantic comparison)

**Do not commit:** `acme.json`, any file containing real secrets, production site files.
