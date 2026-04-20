# Admin UI for siteio

**Status:** Design approved 2026-04-20
**Scope:** A browser-based admin UI served by the existing `AgentServer` at `https://api.<domain>/ui`, letting an operator authenticate with their API key and perform the same dashboard + lifecycle operations the CLI exposes today.

## Goal

Give siteio operators a zero-install way to inspect and operate their deployment from a browser: list sites, apps, and groups; view app detail and logs; run lifecycle actions on apps (deploy, stop, restart, remove); undeploy and roll back sites. The UI talks to the **existing** JSON API — the same endpoints the CLI calls — so there is no separate contract to maintain.

## Non-goals

- Creating apps from the UI (image / git / compose / inline-dockerfile flows).
- Editing app configuration: env vars, volumes, domains, OAuth, restart policy.
- Deploying sites by drag-and-drop zip upload.
- Managing groups: create, update members, delete.
- Updating site domains, OAuth, toggling persistent storage, or renaming sites.
- Server-side rendering, HTML fragments, HTMX, or any server framework (Hono, Express, etc.). The server serves static HTML/JS/CSS and nothing else for the UI.
- New JSON API endpoints, new WebSocket or SSE endpoints. Everything is implemented against today's API contract.
- Dark mode, full mobile drawer (sidebar collapses to icons below 768px, that's it), i18n.
- Changes to the CLI or the JSON API contract.

## User experience

### Login

`https://api.<domain>/ui` loads a single HTML page. If no API key is in `sessionStorage`, the page renders a login form with one password-style input and a submit button. On submit the UI calls `GET /sites` with the entered key in `X-API-Key`:

- `200` → key is stored in `sessionStorage`, the dashboard replaces the login form.
- `401` → the form shows an inline "Invalid API key" error.
- network error → the form shows "Could not reach server".

### Dashboard layout

Fixed left sidebar (~220px) holds the logo-mark, the current hostname (from `window.location.hostname`), three nav links (Apps / Sites / Groups) and a logout button. The main area shows a page title bar and the current view's content. Below 768px the sidebar collapses to icons only.

### Views

All routing is hash-based. One HTML document, Alpine swaps views on `hashchange`.

| Route | Content |
|-------|---------|
| `#/` (default) | redirect to `#/apps` |
| `#/apps` | Apps list (Name / Type / Status / Domains / Actions) |
| `#/apps/:name` | App detail: lifecycle buttons + Overview and Logs sub-tabs |
| `#/sites` | Sites list (Subdomain / Size / Version / Deployed / TLS / Actions) |
| `#/sites/:subdomain` | Site detail: Overview and History sub-tabs |
| `#/groups` | Groups list (read-only, rows expand inline to show members) |

### Actions available in MVP

| Resource | Actions |
|----------|---------|
| Apps | deploy, stop, restart, remove |
| Sites | undeploy, rollback to a historical version |
| Groups | none (read-only) |

Destructive actions (remove app, undeploy site) use the browser's native `confirm()` dialog.

## Architecture

### Module layout

New code lives in a single folder next to the agent server:

```
src/lib/agent/ui/
  index.html     # real HTML file, authored as HTML
  app.js         # real JS file: Alpine components, hash router, API client, renderers
  app.css        # small custom CSS on top of Tailwind (status badges, logs pre)
  assets.ts      # imports the three above with { type: "text" } and re-exports as strings
```

`server.ts` imports from `./ui/assets.ts` and wires the three strings into the routes map. Because Bun's `--compile` bakes text imports into the binary, the single-binary release is unaffected.

No files are shared with `storage-shim.ts` — that module serves a completely different concern (per-site persistent storage shim injected into customer sites).

### Routing integration

`AgentServer.start()` switches from `Bun.serve({ fetch })` to `Bun.serve({ routes, fetch })`:

```ts
Bun.serve({
  port,
  routes: {
    "/ui":         () => new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    "/ui/app.js":  () => new Response(APP_JS, { headers: { "Content-Type": "application/javascript; charset=utf-8" } }),
    "/ui/app.css": () => new Response(APP_CSS, { headers: { "Content-Type": "text/css; charset=utf-8" } }),
  },
  fetch: (req) => this.handleRequest(req),
})
```

Every existing route — `/health`, `/oauth/status`, `/auth/check`, `/__storage/*`, `/sites`, `/sites/:subdomain/*`, `/apps`, `/apps/:name/*`, `/groups`, `/groups/:name/*` — is reached via the `fetch` fallback, unchanged. The routes map owns only the three admin UI paths. The existing 300+ line `handleRequest` is not refactored as part of this work.

Only `GET /ui` / `GET /ui/app.js` / `GET /ui/app.css` are served; non-GET requests to those paths fall through to `handleRequest` and return 404 the same way any other unknown path does today.

### Client dependencies (all CDN, no build step)

- **Alpine.js 3.x** — client-side reactivity and state
- **Tailwind CSS 4.x** — utility-first styling
- **HugeIcons** — icon set (same CDN link as `WEB_TECH_GUIDELINES.md`)
- **Geist** + **Fira Mono** via Google Fonts

Tailwind runtime config overrides the color palette with siteio brand values from `brand/GUIDELINES.md`:

- `primary` → `#0969da` (brand blue) for active nav, links, primary CTAs
- `success` → `#2da44e` (brand green) for running status and success toasts
- Gray scale kept from the guideline template
- `fontFamily.sans` → Geist, `fontFamily.mono` → Fira Mono

### Authentication flow

The admin UI is gated solely by the siteio API key — the same trust boundary the CLI uses. `api.<domain>` is not put behind OAuth forwardAuth; that remains reserved for customer sites and apps.

**Storage:** `sessionStorage` under the key `siteio_api_key`. Session-scoped (cleared on tab close), never persisted. No cookies.

**Boot:** on page load, the Alpine root reads `sessionStorage`. If the key is present, the default view (`#/apps`) renders; otherwise the login view renders.

**`apiFetch` wrapper:** every authenticated request goes through a thin wrapper:

```js
async function apiFetch(path, options = {}) {
  const key = sessionStorage.getItem("siteio_api_key")
  const res = await fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), "X-API-Key": key },
  })
  if (res.status === 401) {
    sessionStorage.removeItem("siteio_api_key")
    window.dispatchEvent(new CustomEvent("siteio:unauthenticated"))
    throw new Error("Unauthenticated")
  }
  return res
}
```

The `siteio:unauthenticated` event is listened for by the root Alpine component, which flips `authed` to `false` and shows the "Session expired" message on the login form. A single point of failure handling means no stale-key behavior can leak into any view.

**Logout** clears `sessionStorage` and dispatches the same event.

### Alpine structure

A single root `x-data` on `<body>` owns app-wide state. Sub-components declare their own `x-data` only when they need scoped local state (e.g. "is this kebab menu open").

Root shape:

```js
{
  // auth
  apiKey: null, authed: false, loginError: "",

  // route
  route: { view: "apps", param: null, subtab: "overview" },

  // data (lazy-loaded per view, kept in memory until explicit refresh or mutation)
  sites: null, apps: null, groups: null,
  selectedSite: null, selectedApp: null,
  appLogs: "", appLogsAutoRefresh: true, appLogsTimer: null,

  // ui
  toasts: [],
  pending: new Set(),  // e.g. "deploy-myapp", "restart-myapp"

  // lifecycle
  init() { /* read session, attach hashchange, parse route, fetch if authed */ },
  onHashChange() { /* parse route, trigger per-view loader */ },
  login(apiKey) { /* validate, persist, swap to dashboard */ },
  logout() { /* clear, swap to login */ },

  // data loaders
  loadApps() {}, loadApp(name) {},
  loadSites() {}, loadSite(subdomain) {},
  loadGroups() {},

  // actions (each pushes a pending flag, runs the mutation, refetches)
  deployApp(name) {}, stopApp(name) {}, restartApp(name) {}, removeApp(name) {},
  undeploySite(subdomain) {}, rollbackSite(subdomain, version) {},

  // logs polling
  startLogsPoll() {}, stopLogsPoll() {},

  // toasts
  toast(type, message) {},
}
```

All mutations go through `apiFetch`, push a flag into `pending`, and refetch the relevant list or detail on success before clearing the flag.

### Data flow

- **List views** fetch on route entry, hold the array in Alpine state until the user hits "Refresh" or performs a mutation that invalidates them.
- **Detail views** fetch on route entry; not kept in memory on leave.
- **Mutations** are fetch-after-mutate (no optimistic updates). Buttons expose `x-bind:disabled="pending.has(...)"` and show an inline spinner while the action is in flight.
- **404 on a detail fetch** renders an "Item not found" empty state with a back link to the list.

### Long-running deploys

`POST /apps/:name/deploy` blocks until the build + run completes — potentially minutes for git or compose apps. The UI uses a fire-and-hold model: the button sits in "Deploying…" (disabled, spinner) until the POST resolves, then shows a success or failure toast and refetches the app detail. Browsers hold fetches open indefinitely, so a 5-minute build just sits. If the user navigates away and comes back, the next detail fetch reflects whatever server-side status ended up being. This matches how the CLI behaves when killed mid-deploy.

Streaming deploy progress would need a new backend endpoint (SSE or WebSocket); that is explicitly out of scope for MVP.

### Log tailing

The existing endpoint `GET /apps/:name/logs?tail=N` returns the last N lines as a single string. The UI fetches `tail=200` by default.

- Auto-refresh is **ON by default** with a **3-second** interval. A checkbox in the Logs sub-tab header toggles it; when off, a "Refresh now" button replaces the interval.
- The poll runs via `setInterval`. It is cleared on sub-tab leave, view change, and tab visibility change (Page Visibility API) — we don't poll while the browser tab is backgrounded.
- Display: monospace `<pre>` in Fira Mono, scroll-locked to the bottom while auto-refresh is on. If the user scrolls up, the lock disengages until they scroll back to the bottom.
- Compose-specific flags (`all=true`, `service=X`) are out of scope; the UI fetches primary-service logs with server defaults.

## Error handling

| Category | Detection | UX |
|---|---|---|
| 401 Unauthorized | any response status 401 | `apiFetch` clears session + dispatches `siteio:unauthenticated` → login view with "Session expired, sign in again" |
| Network error | `fetch` throws | toast: "Could not reach server" + "Retry" button on the affected view |
| 4xx from API | `ApiResponse.success === false` | toast with `ApiResponse.error` verbatim (server messages are already human-readable) |
| 404 on detail fetch | detail GET returns 404 | empty-state in the detail pane, link back to the list |

No global error boundary. No retries on mutations (we don't want to accidentally deploy twice).

## Testing

### Server-side integration tests (Bun test runner)

A new `src/__tests__/admin-ui-routes.test.ts` starts an `AgentServer` with `skipTraefik: true` on a random port and asserts:

- `GET /ui` returns 200, `Content-Type: text/html; charset=utf-8`, and a body containing the expected `<html>` / `<div id="app">` markers.
- `GET /ui/app.js` returns 200 with `Content-Type: application/javascript; charset=utf-8`.
- `GET /ui/app.css` returns 200 with `Content-Type: text/css; charset=utf-8`.
- `GET /ui/nonexistent` falls through to `handleRequest` and returns 404.
- Existing canary paths still behave exactly as before (`/health` → 200 no-auth, `/sites` → 401 without key, `/sites` → 200 with key). This guards against regression from the routes-map switch.

### Browser-level tests (Playwright)

Wired up from slice 1 so each subsequent slice extends the same suite. A new `tests/playwright/` folder holds specs; a new `bun run test:e2e` script runs them; Playwright is added as a dev dependency. Each test starts a real `AgentServer` on a random port and points a headless browser at `http://127.0.0.1:<port>/ui`.

Minimum coverage:

- **Login**: invalid key → inline error, key stays on form. Valid key → dashboard renders, `sessionStorage` contains the key.
- **Apps list**: with seeded apps, rows render; clicking a row navigates to `#/apps/:name`.
- **App detail**: Overview sub-tab shows expected fields; lifecycle buttons call the expected endpoints (intercepted at the network level to assert).
- **Logout**: button clears `sessionStorage` and returns to login.
- **Session expiry**: when the server returns 401, the UI swaps to login with the "Session expired" message.

Heavier scenarios (actual deploy, actual log polling) remain manual for MVP.

## Implementation slicing

Each slice is an independent, shippable PR. Order:

1. **Shell + routes + Playwright scaffold.** Static `/ui`, `/ui/app.js`, `/ui/app.css` serving through the `Bun.serve` routes map. Empty Alpine app: sidebar + empty main area + Playwright infra and one smoke test (`/ui` loads, sidebar is visible).
2. **Login + `apiFetch` + session handling.** Login view, sessionStorage, centralized 401, logout button, `siteio:unauthenticated` event. Playwright: login with valid/invalid key, logout, session expiry.
3. **Apps list (read-only).** Fetch + render + Refresh button. Playwright: list renders, row click navigates.
4. **App detail: Overview sub-tab.** Fetch and render app fields; no actions yet. Playwright: detail renders with seeded app.
5. **App lifecycle actions.** Deploy / stop / restart / remove with `confirm()` for destructive actions, pending spinners, toasts, detail refetch on success. Playwright: each action calls the expected endpoint.
6. **App logs sub-tab.** Polling (3s), pause toggle, Page Visibility integration, scroll-lock. Playwright: logs render and update on tick.
7. **Sites list + detail.** Sites list, Overview + History sub-tabs, undeploy, rollback per version.
8. **Groups list.** Read-only, expandable rows.
9. **Polish pass.** Toast styling, empty states, error states, keyboard niceties (Esc closes confirm-style modals if we add any, focus management on login).

Done when slice 9 merges.
