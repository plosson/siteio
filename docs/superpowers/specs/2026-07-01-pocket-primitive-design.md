# PRD: The `pocket` Primitive — PocketBase-backed Sites

**Status:** Draft for review
**Date:** 2026-07-01
**Owner:** Pierre-Alexandre Losson

---

## 1. Summary

Add a third first-class primitive to siteio, alongside `site` and `app`:

- **`site`** — static / simple hosting (unchanged).
- **`app`** — full Dockerized application for experienced developers (unchanged).
- **`pocket`** — a **PocketBase-backed site**: a static frontend *plus* a real
  backend (SQLite database, authentication, file storage, REST + realtime API)
  delivered by a single self-contained binary.

A `pocket` gives the user storage and auth **by default**, is **testable
locally with no Docker**, and **deploys in one command**.

## 2. Problem & motivation

siteio's newbie-facing primitive (`site`) hosts static files. The fastest-growing
usage pattern is non-technical "vibe coders" who drive an LLM agent: they make a
folder, launch a model, and say *"use siteio to build a site that does X, Y, Z."*
Today the LLM scaffolds static files and launches a local static file server to
test — and that works well.

The moment the requested site needs to *store* anything — a form submission, a
user account, an uploaded file — the static primitive is a dead end. These users
have no backend expertise and rely entirely on the LLM; asking them (or the LLM)
to stand up a separate backend, install Docker, or wire a database is out of
scope for who they are.

**We want the base of these sites to always have a backend**, so users get
storage/auth for free, can test locally exactly as they do today, and deploy with
one command.

## 3. Goals

- A dedicated `pocket` primitive whose default state includes a working backend.
- **Local testing with zero Docker** — a single command that serves the site and
  its backend, slotting into the LLM's existing "launch a local server, hit it,
  iterate" habit.
- **One-command deploy** with perfect local↔production parity (byte-identical
  PocketBase binary/version in both environments).
- **LLM-native workflow**: schema defined as migration files (code), not
  admin-panel clicks.
- Reuse existing siteio machinery (storage extraction, volumes, Traefik wiring)
  rather than building a parallel subsystem.

## 4. Non-goals (v1)

- **Backups / restore** (`pocket backup`). v1 persists `pb_data` on a volume;
  scheduled/one-shot backups are a follow-up.
- **Scale-to-zero.** v1 runs one always-on container per pocket. Stop-idle /
  start-on-first-request is a documented follow-up and the acknowledged cost of an
  always-on backend.
- **Changes to `site` or `app`.** Those primitives are untouched. A pocket never
  "becomes" an app in the UX; it reuses container machinery internally but is only
  ever surfaced as a `pocket`.
- **Custom/arbitrary backend runtimes.** A pocket *is* PocketBase. Users who want
  an arbitrary container use `app`.

## 5. Target user & primary workflow

**User:** non-technical, LLM-driven. Never opens a terminal by choice; the agent
runs the commands.

**Workflow the design optimizes for:**

1. `siteio pocket init` — the LLM scaffolds a folder.
2. The LLM writes HTML/JS and `pb_migrations/*.js` to define collections.
3. `siteio pocket dev` — the LLM runs this to serve the site + backend locally,
   then hits `http://localhost:8090` to verify behavior (no Docker involved).
4. `siteio pocket deploy` — one command ships it live.

The critical UX insight: **`pocket dev` replaces the LLM's current habit of
launching a static file server.** The agent already knows how to "start a server
and test against it" — `pocket dev` is that server, and it happens to also expose
`/api`, auth, and file storage.

## 6. Local project layout

The user's folder stays clean — their `index.html`/JS live at the root.
PocketBase is run with `--publicDir=./` so the folder root is the web root. All
backend plumbing is hidden under `.siteio/` (the existing config directory):

```
myproject/
  index.html              # user content (web root)
  app.js
  .siteio/
    config.json           # existing config, extended: type=pocket + pinned PB version
    pb_migrations/        # schema-as-code — authored by the LLM, travels local→prod
    pb_hooks/             # optional JS backend logic
    pb_data/              # LOCAL sandbox DB — gitignored, NEVER deployed
```

- `pb_migrations/` is the source of truth for schema. It applies on boot both
  locally and in production, making schema reproducible.
- `pb_data/` locally is a throwaway sandbox. Production `pb_data` is the real
  data and lives only on the server volume.
- `siteio pocket init` adds `pb_data/` to `.gitignore` (creating the file if
  absent).

## 7. Commands

### `siteio pocket init [folder]`
Scaffolds the layout above: `.siteio/` structure, a starter `pb_migrations`
entry, and a starter `index.html` wired to the PocketBase JS SDK. Sets
`type: pocket` and the pinned PocketBase version in `.siteio/config.json`.
Idempotent and non-interactive.

### `siteio pocket dev`
The local runner. **No Docker, ever.**
- Ensures the pinned PocketBase binary is present: downloads the correct
  OS/arch build once and caches it (e.g. `~/.siteio/bin/pocketbase-<version>`),
  verifying a checksum. Mirrors the `siteio update` self-management pattern.
- Runs `pocketbase serve` with `--publicDir=./`, migrations dir, hooks dir, and
  data dir pointed at the `.siteio/` locations.
- Prints the local URL (`http://localhost:8090`) to stdout; runs in the
  foreground; is cleanly killable. Non-interactive (no blocking admin prompt).

### `siteio pocket deploy`
- Collects **code only** — the web root files + `pb_migrations/` + `pb_hooks/`.
  **Explicitly excludes `.siteio/pb_data/` and the cached binary.** This mirrors
  the existing `sites` zip/`collectFiles` flow with an added exclusion.
- Uploads to the agent. The server runs the shipped, version-pinned
  `siteio-pocketbase` image with the uploaded code mounted read-only and
  `pb_data` on a persistent volume. Migrations apply on boot.
- Preserves the code-versioning/history story from `sites`. **Never touches
  `pb_data`.**

### `siteio pocket list / info / logs / rm`
Mirror the existing `site`/`app` management verbs.

### `siteio pocket admin`
Reveals the auto-generated PocketBase superuser credentials for the deployed
admin UI (see §9).

## 8. Server-side architecture

A pocket is **one container per site** — PocketBase cannot be shared across sites
(each has its own database, auth, and hooks). This is a deliberate departure from
the shared-nginx model used by static `sites`, and the reason scale-to-zero is on
the roadmap (§4, §12).

A new `PocketStorage` composes two patterns already in the codebase:

- **Code** (web root + `pb_migrations/` + `pb_hooks/`): extract-and-mount
  **read-only**, following the `SiteStorage` extraction pattern. Retains
  versioning/history/rollback **for code**.
- **State** (`pb_data/`): a persistent volume under the agent data dir, following
  the `AppStorage` volume pattern.

The container runs the **shipped, version-pinned `siteio-pocketbase` image**
(built and published by siteio's release pipeline — no per-site `docker build`).
User code arrives via the read-only mount, not baked into the image. Routing uses
the existing Traefik Docker-label path: one router, one domain
(`<name>.<domain>`), TLS via the existing Let's Encrypt resolver.

### Deploy artifact boundary (critical)

| Artifact | Origin | Deployed? | Rolled back? |
|---|---|---|---|
| Web root files | user folder | Yes | Yes |
| `pb_migrations/` | user folder | Yes | Yes (code) |
| `pb_hooks/` | user folder | Yes | Yes |
| `pb_data/` (DB, uploads) | server volume | **No — server-only** | **No — never** |
| PocketBase binary | shipped image | Image, not upload | N/A |

## 9. Auth & admin

- **Out of the box: PocketBase email/password auth.** Zero external setup — the
  self-contained default for the target user.
- **Optional Google social login.** Supported but **off by default**. The user or
  LLM supplies a Google OAuth client ID/secret via a `pocket` config/env command;
  siteio configures PocketBase's Google auth provider and sets the correct
  redirect URL per environment (localhost for `dev`, the pocket's domain for
  production). Enabling it requires the user to obtain credentials from the Google
  console — an explicitly advanced, opt-in path, not the default experience.
- **Admin UI (`/_/`): protected by PocketBase superuser only.** siteio
  auto-generates a superuser on first deploy and stores the credentials; `siteio
  pocket admin` reveals them. No Traefik/oauth2-proxy changes are required. The
  admin login page is reachable on the public domain but useless without
  credentials.

> Note: this uses PocketBase's *own* auth for end users, which is orthogonal to
> siteio's existing oauth2-proxy edge auth. A public pocket with PocketBase logins
> must **not** be fronted by siteio OAuth, or the edge proxy would block every
> visitor before PocketBase sees them. The two auth systems are alternatives, not
> layers.

## 10. Hard boundaries & invariants

- **Rollback covers code, not data.** Deploy and rollback operate on code
  (web root, migrations, hooks). `pb_data` is never rolled back or overwritten.
  This must be surfaced honestly to users — a redeploy never risks their data,
  and a rollback never restores lost records.
- **Version pinning is mandatory.** The locally cached binary and the production
  `siteio-pocketbase` image are the *same* pinned PocketBase version. Divergence
  risks `pb_data` migration drift. Upgrading the pinned version is a deliberate,
  migration-aware operation.
- **Schema is migrations, not admin clicks.** The intended path for defining
  collections is `pb_migrations/*.js` (code the LLM writes, reproducible
  local→prod). The admin UI is secondary.

## 11. Reuse map (implementation-facing)

| Concern | New | Reuses |
|---|---|---|
| CLI command group | `src/commands/pocket/*`, registered in `src/cli.ts` | mirrors `commands/sites` |
| Client methods | `createPocket`/`deployPocket`/… in `src/lib/client.ts` | mirrors site/app methods |
| Agent routes | `POST/GET/DELETE /pockets/:name` in `server.ts` | same dispatcher pattern |
| Server storage | `PocketStorage` | `SiteStorage` (code extract) + `AppStorage` (volume) |
| Container + routing | pinned `siteio-pocketbase` image via `DockerManager.run` + `buildTraefikLabels` | existing app/Traefik path |
| **Local `pocket dev`** | binary download/cache/pin + spawn runner | **genuinely new — no local-run exists today** |
| Deploy artifact | `collectFiles` excluding `.siteio/pb_data` + binary | mirrors sites zip |

The only substantially new machinery is the **local runner and pinned-binary
management**; everything else is reuse of existing patterns.

## 12. Follow-ups (post-v1)

- **`pocket backup` / restore** — wrap PocketBase's backup API + the volume.
- **Scale-to-zero** — stop idle pocket containers, start on first request, to
  reclaim the cost of one always-on container per pocket.
- **Additional social providers** beyond Google.

## 13. Open questions

- None blocking. Version-upgrade UX (how a user moves to a newer pinned
  PocketBase version with migration safety) is deferred to the follow-up that
  first requires it.

## 14. Success criteria

- An LLM can scaffold a pocket, define a collection via a migration, run
  `pocket dev`, create a record through the API locally, and `pocket deploy` —
  with Docker installed nowhere on the user's machine.
- A redeploy of a live pocket never alters or destroys `pb_data`.
- Local and production run the identical pinned PocketBase version.
