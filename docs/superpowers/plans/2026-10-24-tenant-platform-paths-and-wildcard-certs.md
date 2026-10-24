# Tenant platform paths switch and wildcard tenant certificates: plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:**
- A tenant can be created with `platformPaths: false`, so siteio's `/mcp`, `/_siteio` and OAuth well-known paths never answer on its site hosts.
- With DNS-01, each tenant gets one wildcard certificate.

**Spec:** `docs/superpowers/specs/2026-10-24-tenant-platform-paths-and-wildcard-certs-design.md`

**Tech stack:** Bun, TypeScript, `bun test`, and Traefik v3.7 file provider config generated as a string.

## Global constraints

- Absent `platformPaths` means on. Only `false` is stored.
- The regex per opted-out tenant is `^(.+\.)?<domain with dots escaped>$`.
- The Traefik rule is unchanged when no tenant opts out. The existing test that asserts no `HostRegexp` stays valid in that case.
- `tls.domains` is emitted only when `acme.challenge === "dns"`.
- Follow siteio patterns: hand-written routing, `this.json` and `this.error`, the test style in `src/__tests__/api/tenants.test.ts` and `src/__tests__/unit/traefik-manager.test.ts`, and `skipTraefik: true` in API tests.
- Use a branch, then a PR, then a merge, then the bump PR to 1.53.0, then the tag `v1.53.0`.

## Review focus

1. **Suffix overlap:** tenant `b.app` opts out and tenant `ab.app` doesn't. `x.ab.app/mcp` must still work. *(Task 1)*
2. **Tenant removed:** a tenant is removed while opted out. Its exclusion disappears and nothing else changes. *(Task 1)*
3. **Domains with special characters:** a tenant domain containing `-`. The regex escaping keeps it correct. *(Task 1)*

### Task 0: Write `dynamic.yml` atomically

**Why:** Nino found this live. `updateDynamicConfig` (`traefik.ts` ~285) does `writeFileSync` straight onto the watched `dynamic.yml`. If Traefik reads it between the truncate and the write, it sees an empty or partial config and drops every router in it. That includes `api-router`, which holds every API host. So any tenant being added or removed can briefly make every tenant's API host, and the main one, answer `404 page not found`.

**Files:**
- Modify: `src/lib/agent/traefik.ts` (`updateDynamicConfig`): write to `dynamic.yml.tmp-<pid>-<random>` in the same directory, then `renameSync` it over `dynamic.yml`. Do the same for any other file the Traefik watcher reads that is rewritten at runtime, if there is one.
- Test: `src/__tests__/unit/traefik-manager.test.ts`. After `setApiHosts`, check that the file is complete, that no temp file is left, and that a reader polling during many quick rewrites never sees an empty or partial file. Poll in a loop with `readFileSync` while rewriting about 200 times, and assert that every read parses and contains `api-router`.

- [ ] **Step 1: Write the failing test.** Expect it to be flaky or failing before the fix. Document what you see.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run the full suite.**
- [ ] **Step 4: Commit.** `fix(agent): write Traefik dynamic config atomically`

### Task 1: `platformPaths` flag

**Files:**
- Modify: `src/types.ts` (`Tenant`), `src/lib/agent/server.ts` (`handleAddTenant` ~1683, `liveHostContext` ~3040, the calls to `setApiHosts` at ~265-276, ~1707 and ~1730), `src/lib/agent/traefik.ts` (`TraefikConfig`, `generateDynamicConfig` ~195-235, a new `setPlatformOffDomains` beside `setApiHosts` ~290), `src/lib/agent/tenants.ts` (`summaries`, plus a helper `platformOffDomains()`), `src/commands/agent/tenant.ts` and the command registration (`--no-platform-paths`)
- Test: `src/__tests__/api/tenants.test.ts`, `src/__tests__/unit/traefik-manager.test.ts`, `src/__tests__/cli/agent-tenant.test.ts`

- [ ] **Step 1: Write failing tests** for everything in the spec's Tests section about the flag and routing, plus Review focus 1–3.
- [ ] **Step 2: Run them.** `bun test src/__tests__/api/tenants.test.ts src/__tests__/unit/traefik-manager.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite.** `bun test && bun run typecheck`. Expect green. The known exception is the `integration/docker.test.ts` port clash if host port 18080 or 8080 is taken; report it if it appears.
- [ ] **Step 5: Commit.** `feat(agent): per-tenant switch for platform paths`

### Task 2: Wildcard `tls.domains` per tenant under DNS-01

**Files:**
- Modify: `src/lib/agent/traefik.ts` (`api-router` tls, and `toYaml`'s array-of-scalars branch ~264)
- Test: `src/__tests__/unit/traefik-manager.test.ts`

- [ ] **Step 1: Write failing tests.**
  - `dns` with tenants `k7f2.mynino.app` and `x9.mynino.app` gives `domains` entries with `main` and the quoted `"*.k7f2.mynino.app"`.
  - `http` gives no `domains`.
  - The generated YAML parses (use `Bun.YAML.parse` if available, otherwise a strict check of the emitted lines), and `sans[0]` is the string `*.k7f2.mynino.app`.
  - Existing array output (for example `entryPoints`) still parses to the same values.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite.** Expect green.
- [ ] **Step 5: Commit.** `feat(agent): wildcard certificate per tenant with DNS-01`

### Task 3: PR, merge, release 1.53.0

- [ ] Push the branch. Open the PR with both commits plus these spec and plan files.
- [ ] After the review is clean, squash-merge it.
- [ ] Bump `package.json` to 1.53.0 in its own PR and merge it.
- [ ] Tag `v1.53.0` and push the tag.
- [ ] Check that the Release action starts.
