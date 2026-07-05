# Merge pocket into sites

**Goal:** There is only one way to deploy a static site: the pocket implementation, exposed under the name `sites`. Every site is a PocketBase-backed container — even if the user never touches the backend. The legacy shared-nginx static-site implementation is removed. `siteio pocket` survives as a hidden alias for a transition period.

**Decisions made:**
- OAuth edge protection is dropped (not needed for now). oauth2-proxy machinery goes away with the legacy sites implementation.
- Persistent localStorage (`/__storage` shim) is dropped — pockets have a real database.
- Custom domains, rename, and history/rollback are kept: they must be ported onto the pocket implementation (pocket has partial plumbing but no endpoints/commands, see gap analysis below).
- Existing legacy static sites on the agent are **auto-migrated** on startup into pocket-style deployments.
- On-disk agent directory names stay `pockets/`, `pocket-code/`, `pocket-data/`, `pocket-history/`. Renaming them would force recreating every running pocket container (mounts use absolute paths) for zero user-visible benefit. Same for the published `ghcr.io/plosson/siteio-pocketbase` image name and `POCKET_*` env vars — internal names, not user surface.

## Gap analysis (what pocket already has vs. what must be built)

| Capability | Pocket today | Work needed |
|---|---|---|
| Custom domains | `Pocket.domains: string[]` exists; `buildTraefikLabels` already builds multi-host rules; `primaryDomain()` resolves domains[0] | Endpoint + CLI only, plus container recreate on change |
| History | `archiveCode()` keeps last 10 versions in `pocket-history/<name>/v<N>/` | Per-version metadata (`v<N>.json`), `GET history` endpoint, CLI |
| Rollback | Nothing | `POST rollback` endpoint (code-only, never touches pb_data), CLI |
| Rename | Nothing | Endpoint (meta + dir renames + container recreate), CLI |
| `deploy --test` | Nothing | Trivial port from `sites/deploy.ts` (generates a throwaway test site) |

Note the domains model difference: legacy `SiteMetadata.domains` holds *custom domains only* (default subdomain implied); `Pocket.domains` holds *all* hostnames with the default subdomain at index 0. The merged model keeps pocket's convention; migration must prepend the default subdomain.

## Phase 1 — Capability parity on the pocket server side (additive, nothing breaks)

All under the existing `/pockets/*` routes; renamed in Phase 3.

1. **History metadata** — `pocket-storage.ts`: on `archiveCode()`, also write `v<N>.json` (`{version, deployedAt, deployedBy, size}`) next to the version dir, mirroring `SiteStorage`'s pattern. Add `getHistory(name)`.
2. **`GET /pockets/:name/history`** — returns version list.
3. **`POST /pockets/:name/rollback` `{version}`** — archive current code, copy `v<N>` back to `pocket-code/<name>`, recreate the container (same labels/env/volumes). `pb_data` is never touched (per the pocket design doc: code-only rollback).
4. **`PUT /pockets/:name/domains` `{domains}`** — update metadata (keep default subdomain at index 0), recreate container with new `buildTraefikLabels`.
5. **`POST /pockets/:name/rename` `{newName}`** — validate new name, ensure no collision, stop/remove container, rename meta file + `pocket-code`/`pocket-data`/`pocket-history` dirs, replace default subdomain in `domains`, recreate container. Superuser credentials are passed through unchanged (changing `POCKET_SUPERUSER_EMAIL` would create a second account).

Tests: extend `src/__tests__/api/pockets.test.ts` + `unit/pocket-storage.test.ts` following their existing docker-mocking pattern. `bun run typecheck && bun test` green before Phase 2.

## Phase 2 — Matching CLI commands (still under `pocket`, additive)

- `pocket domain add|rm|list` — port logic from `src/commands/sites/domain.ts`, calling the new endpoint via new `SiteioClient` methods.
- `pocket rename`, `pocket history`, `pocket rollback` — port from the sites equivalents.
- `pocket deploy --test` — port the throwaway-test-site generation from `sites/deploy.ts`.

Register in `src/cli.ts`, add client methods in `src/lib/client.ts`, tests per existing `cli/` and `unit/client-pocket.test.ts` patterns.

## Phase 3 — The switch (breaking release)

1. **Routes:** `/sites` and `/sites/:name` (+ `/download`, `/logs`, `/admin`, `/history`, `/rollback`, `/domains`, `/rename`) are backed by the pocket handlers. `/pockets/*` kept as deprecated aliases to the same handlers (old pocket CLIs keep working). Legacy-only endpoints removed: `PUT /sites/:sub/auth`, `PUT /sites/:sub/storage`, `/auth/check`, `/__storage/*`.
2. **Legacy zip back-compat:** in the deploy handler, if the uploaded zip contains no top-level `public/`, `pb_migrations/`, or `pb_hooks/` entry, treat it as a legacy flat static zip and prefix every path with `public/`. This keeps *old CLIs deploying to a new agent* working. (Known edge: a legacy site with a literal top-level `public/` folder would be misdetected — acceptable.)
3. **Version skew guard:** add `version` (from package.json) to `GET /health`. New CLI preflights deploy: if `/health` has no `version`, fail with "agent is older than this CLI — run `siteio update` on the server". This is the guard against *new CLI → old agent* (which would extract `public/...` as literal file paths).
4. **CLI:** `sites` command group = the pocket implementation: `init, dev, deploy, download, list, info, logs, rm, admin, domain, rename, history, rollback`. `pocket` becomes a hidden alias group registering the same actions. Dropped: `sites auth`, `sites set` (its two jobs were domains → covered by `domain`, and persistent-storage → dropped).
5. **`.siteio/config.json`:** write the `site` key; keep reading `pocket` as a legacy alias (`resolveSubdomain` accepts either, `resolvePocketName` folded in). `pocketbaseVersion` unchanged. The site-vs-pocket cross-rejection guards in `src/utils/site-config.ts` collapse to site-vs-app.
6. **Delete legacy implementation:**
   - `src/lib/agent/storage.ts` (`SiteStorage`), `persistent-storage.ts`, `storage-shim.ts`
   - `src/lib/agent/traefik.ts`: nginx container management, `generateNginxConfig`, per-site routers in `generateDynamicConfig`, all oauth2-proxy container/middleware config. Traefik itself (static config, entrypoints, letsencrypt) stays — apps still route via docker labels.
   - `src/commands/sites/*` (replaced by renamed pocket commands), legacy client methods in `client.ts`, legacy handlers in `server.ts`, legacy types (`SiteMetadata`, `SiteOAuth`, `SiteVersion` — keep whatever the history endpoint reuses).
7. **Internal renames** (now that the names are free): `PocketStorage` → `SiteStorage`, `Pocket`/`PocketInfo` → `Site`/`SiteInfo`, `src/commands/pocket/` → `src/commands/sites/`, `pocket-scaffold.ts` → merged into site scaffolding, etc. Disk paths and the docker image keep their `pocket` names (see decisions).

`bun run typecheck && bun test` green; this is one release-sized commit series, not one commit.

## Phase 4 — Auto-migration of legacy static sites (agent startup)

Trigger: presence of `<dataDir>/metadata/*.json`. For each legacy site `<sub>`:

1. Skip with a loud log if a pocket named `<sub>` already exists (collision).
2. Create pocket metadata: `domains: ["<sub>.<domain>", ...legacyMeta.domains]`, fresh superuser credentials, pinned `pocketbaseVersion`.
3. Move `<dataDir>/sites/<sub>/**` → `<dataDir>/pocket-code/<sub>/public/**`; create empty `pb_migrations`/`pb_hooks`.
4. Migrate history: each `<dataDir>/history/<sub>/v<N>/` → `pocket-history/<sub>/v<N>/public/**`, carrying over the existing `v<N>.json`.
5. Log dropped features per site (OAuth config, persistent-storage data) so nothing disappears silently.
6. Pull the PocketBase image once, then start a container per migrated site.
7. After all sites migrate successfully: move `sites/`, `metadata/`, `history/`, `persistent-storage/`, `nginx/` into `<dataDir>/legacy-backup/` (kept as a backup, not deleted), remove the nginx and oauth2-proxy containers, regenerate `dynamic.yml` without site routers.

Idempotent by construction: once `metadata/` is moved away, the migration never re-runs. A failure mid-way leaves unmigrated sites' metadata in place, so restart resumes.

Tests: unit test the migration against a fixture legacy data dir (`skipTraefik: true` convention), asserting the resulting pocket layout, domains order, and history carry-over.

## Phase 5 — Surfaces

- **Scaffold:** one scaffold, the pocket one, reworded for "site" (static starter + PocketBase SDK + starter migration + CLAUDE.md guide). `site-scaffold.ts` deleted. The guide covers plain-static usage first, backend features second.
- **Skill content** (`src/lib/skill-content.ts`): rewrite for the merged command set, including `dev`, `admin`, migrations.
- **Shell completion** (`src/commands/completion.ts`): merged `sites` subcommand list (also fixes the currently stale list; pocket alias hidden, not completed).
- **Admin UI** (`src/lib/agent/ui/app.js`): sites view consumes the new `/sites` response shape (`url`, `adminUrl`, `status`, `pocketbaseVersion`); container status shown like apps.
- **Landing page** (`site/index.html`): three deploy kinds become two (sites, apps); update hero/terminal demo/cards; fix the stale `siteio sites undeploy` mention.
- **Docs:** README.md, AGENTS.md, CLAUDE.md command examples.

## Phase 6 — Release & production migration

1. **Major version bump** — breaking: OAuth and persistent-storage removed; agent must be updated together with the CLI.
2. Standard release flow (tag, Actions build).
3. Update the siteio.me server (`ssh siteio "... update -y && ... agent restart"`) and watch the agent log for the migration report.
4. Verify: the landing page (itself a migrated legacy site) serves over HTTPS, custom domains still route, `siteio sites list` shows everything running, one rollback smoke test.
5. Keep `<dataDir>/legacy-backup/` until verified, then clean up manually.

## Risks

- **CLI/agent skew** is the sharpest edge: there is no version negotiation today. The Phase 3 `/health` version + preflight is the mitigation; release notes must say "update agent first".
- **Resource cost:** every static site now runs a PocketBase container (~30–50 MB RSS each) instead of sharing one nginx. Accepted trade-off; worth watching after migrating a server with many sites.
- **Migration is the riskiest code.** It only moves/copies files and starts containers — it never deletes (backup dir instead), and resumes on restart. Test against a copy of the real siteio.me data dir before releasing if possible.
