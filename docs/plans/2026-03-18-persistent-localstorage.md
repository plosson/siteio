# Persistent localStorage for Static Sites — Implementation Plan

**Status:** Implemented (branch: `feat/persistent-storage`)

**Goal:** Give static sites deployed on siteio truly persistent `localStorage` — surviving browser cache clears and working across devices — without requiring any code changes to the deployed apps.

**Architecture:** Override `window.localStorage` with a JavaScript shim injected via nginx `sub_filter`. The shim proxies reads/writes to a server-side KV store exposed at `/__storage/`. Data is hydrated on page load via synchronous XHR, and writes are debounced and synced back asynchronously.

**Tech Stack:** Bun, TypeScript, nginx (`sub_filter`), Traefik, Commander.js

---

## Context & Motivation

An analysis of all 21 deployed static sites revealed that **13 use localStorage** and **7 store meaningful user data** (pixel art maps, high scores, saved presets, learning progress, pad configurations). This data is lost when the browser cache is cleared or when accessing from another device.

### Sites that benefit

| Site | What's stored |
|---|---|
| tamagoshi | Pixel art tile maps, custom creatures/tiles, theme, toolbar state |
| soundboard | Pad configuration (sounds, labels, colors) |
| space-shooter | High scores, campaign progress |
| claude-code-academy | Learning progress |
| quote-renewal | Paid quote IDs |
| ascii / ascii-tools / ascii-creative-tools | User-saved presets |
| axel | Saved presets |

### Design decisions

1. **Sync XHR for hydration** — The shim uses a synchronous `XMLHttpRequest` on page load to fetch the remote state before any app code runs. Browsers show a deprecation warning in the console, but this is the only approach that works transparently without requiring app changes. The alternative (server-side HTML injection with inline data) was considered but adds more server-side complexity.

2. **nginx `sub_filter` for injection** — Static sites are served by nginx, not the Bun agent server. The `sub_filter` directive replaces `</head>` with `<script src="/__storage/shim.js"></script></head>` in HTML responses. Sites with `persistentStorage` enabled get their own explicit nginx server block (overriding the regex catch-all) so injection is per-site.

3. **Per-user when OAuth enabled** — When a site has OAuth protection, storage is keyed per-user using the `X-Auth-Request-Email` header already set by oauth2-proxy. Anonymous sites share a single storage pool.

4. **File-based storage** — Storage is simple JSON files on disk (`{dataDir}/persistent-storage/{subdomain}/{key}.json`), capped at 1MB per store. No database needed.

---

## Implementation

### Task 1: Add `persistentStorage` to types

**Files:**
- Modify: `src/types.ts`

Add `persistentStorage?: boolean` to:
- `SiteMetadata` interface (stored by agent)
- `SiteInfo` interface (returned to clients)

---

### Task 2: Persist the flag in SiteStorage

**Files:**
- Modify: `src/lib/agent/storage.ts`

1. In `extractAndStore`, preserve `persistentStorage` from `existingMetadata` across redeploys (same pattern as `domains`)
2. In `rollback`, preserve `persistentStorage` from existing metadata
3. Add `updatePersistentStorage(subdomain, enabled)` method (modeled after `updateOAuth`)

---

### Task 3: Create PersistentStorageManager

**Files:**
- Create: `src/lib/agent/persistent-storage.ts`

A new class managing on-disk JSON files:

```
{dataDir}/persistent-storage/{subdomain}/_anonymous.json  (no OAuth)
{dataDir}/persistent-storage/{subdomain}/{email}.json     (per-user with OAuth)
```

Methods:
- `get(subdomain, userEmail?)` — read JSON, return `Record<string, string> | null`
- `set(subdomain, data, userEmail?)` — validate size <= 1MB, write JSON
- `deleteSite(subdomain)` — remove entire site directory

---

### Task 4: Create the JavaScript shim

**Files:**
- Create: `src/lib/agent/storage-shim.ts`

Exports a `STORAGE_SHIM_JS` string constant containing the minified JS:

1. On load: synchronous XHR GET to `/__storage/` — hydrates an in-memory cache object
2. `getItem(k)` — read from cache (synchronous)
3. `setItem(k, v)` — write to cache, schedule debounced async PUT to `/__storage/`
4. `removeItem(k)` — delete from cache, schedule sync
5. `clear()` — empty cache, schedule sync
6. `key(n)` / `length` — read from cache keys
7. Override `window.localStorage` via `Object.defineProperty`

Writes are debounced at 300ms to avoid excessive API calls.

---

### Task 5: Add server routes

**Files:**
- Modify: `src/lib/agent/server.ts`

**Non-authenticated routes** (browser-facing, before `isApiRequest` check):
- `GET /__storage/shim.js` — serve the shim JS with `application/javascript` content-type
- `GET /__storage/` — return the JSON storage blob for the site (identified from Host header or `X-Site-Subdomain` header in test mode)
- `PUT /__storage/` — store JSON blob, enforce 1MB limit (413 on overflow)

**Authenticated route** (API key required):
- `PATCH /sites/:subdomain/storage` — toggle `persistentStorage` on/off, regenerate nginx config

**Other changes:**
- Add `persistentStorage` to all `SiteInfo` response mappings (list, deploy, domains, rollback)
- Handle `X-Site-Persistent-Storage` header in deploy handler
- Clean up persistent storage data in `handleUndeploy`
- Add `extractSubdomain(host, req?)` helper that checks `X-Site-Subdomain` header for test mode, or extracts from Host header suffix

---

### Task 6: Update nginx config generation

**Files:**
- Modify: `src/lib/agent/traefik.ts`

1. Add `generateStorageExtra()` helper returning nginx config with:
   - `sub_filter '</head>' '<script src="/__storage/shim.js"></script></head>'`
   - `sub_filter_once on`
   - `sub_filter_types text/html`
   - `location /__storage/ { proxy_pass http://host.docker.internal:{port}; ... }`

2. In `generateNginxConfig`, for each site with `persistentStorage: true`:
   - Generate an explicit server block (overrides regex catch-all) with the storage extra
   - Also apply storage extra to custom domain server blocks

---

### Task 7: Add client method

**Files:**
- Modify: `src/lib/client.ts`

1. Add `updateSitePersistentStorage(subdomain, enabled)` — calls `PATCH /sites/:sub/storage`
2. Extend `deploySite()` signature with `options?: { persistentStorage?: boolean }` — sends `X-Site-Persistent-Storage: true` header

---

### Task 8: CLI deploy flag

**Files:**
- Modify: `src/cli.ts` — add `--persistent-storage` option to `sites deploy`
- Modify: `src/commands/sites/deploy.ts` — pass flag through to client, display status in output

---

### Task 9: CLI set command

**Files:**
- Modify: `src/cli.ts` — add `--persistent-storage` / `--no-persistent-storage` to `sites set`
- Modify: `src/commands/sites/set.ts` — call `updateSitePersistentStorage()` when flag is provided

---

### Task 10: Display in sites info

**Files:**
- Modify: `src/commands/sites/info.ts` — show "Persistent Storage: enabled" when flag is set

---

## Tests

### E2E tests (`src/__tests__/api/persistent-storage.test.ts`) — 20 tests

- Deploy with `--persistent-storage` flag / without / persist across redeploy / show in listing
- Toggle via `PATCH /sites/:sub/storage` (on, off, 404 for missing, auth required)
- `GET/PUT /__storage/` (empty state, store & retrieve, overwrite, 1MB limit, 404 when disabled, 404 for unknown site)
- Per-user isolation via `X-Auth-Request-Email` (different emails, anonymous fallback)
- Site deletion cleanup (verify storage directory removed)
- Shim endpoint (content-type, valid JS content)
- Cross-site isolation

### Unit tests (`src/__tests__/unit/persistent-storage.test.ts`) — 10 tests

- `PersistentStorageManager`: get/set roundtrip, overwrite, 1MB limit, under-limit, deleteSite, safe delete of non-existent, per-user isolation, anonymous vs user, case-insensitive email

### Nginx config tests (added to `src/__tests__/unit/traefik-manager.test.ts`) — 3 tests

- `sub_filter` and `/__storage/` proxy present for persistent-storage sites
- Not present for normal sites
- Applied to custom domain blocks too

---

## Future improvements

- **IndexedDB support** — gifhurlant uses IndexedDB; would need a separate shim with async API proxy
- **Multi-tab conflict resolution** — ETags or timestamps to detect concurrent writes
- **Storage events** — fire `StorageEvent` for cross-tab compatibility
- **Admin dashboard** — view/manage per-site storage usage
- **Selective sync** — allow apps to opt specific keys in/out of remote sync
