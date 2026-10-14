# Shared Google OAuth redirect (`auth.<domain>`) — design

Status: approved for planning (2026-10-14)

## Goal

Sites that use Google login set up PocketBase **as usual**: client ID and secret
in the PocketBase admin, and the stock JS SDK call
`pb.collection('users').authWithOAuth2({ provider: 'google' })`. Nothing else
changes on the site.

Google, however, only ever sees **one redirect URI per base domain**:

    https://auth.<domain>/google/callback

You register it once per Google client. New sites, renamed sites and custom
domains never need a change in the Google console again.

## Decisions

| Topic | Decision |
|---|---|
| Approach | The agent intercepts 2 PocketBase calls on site hosts and hosts a bouncer on `auth.<base>` (no site or PocketBase config change) |
| Switch-over | Always on, no flag. Every Google login on the agent goes through the bouncer |
| Providers | Google only. The code keeps provider data in one table, so another provider is a small addition later |
| Reserved name | `auth` becomes reserved, like `api`. No production site or app uses it, so no migration is needed |
| Scope | Primary domain → `auth.<agent-domain>`. Each tenant → `auth.<tenant-domain>` |
| Sites vs apps | Sites only. Apps own their entire host, so they are never intercepted |

## How a login flows

```
Browser on https://blog.example.com  (or a custom domain)
 1. GET  /api/collections/users/auth-methods ──► agent ──► PocketBase
         agent changes Google's authURL to https://auth.example.com/google/authorize?…
 2. SDK opens popup: authURL + "https://blog.example.com/api/oauth2-redirect", state=<realtime id>
 3. GET  auth.example.com/google/authorize?…&redirect_uri=<site>&state=<s>
         check <site> host is allowed in this scope
         302 → accounts.google.com/o/oauth2/v2/auth?…&redirect_uri=https://auth.example.com/google/callback
                                                     &state=<wrap(site redirect_uri, s)>
 4. Google ─► GET auth.example.com/google/callback?code=…&state=<wrapped>
         unwrap, check the host again
         302 → https://blog.example.com/api/oauth2-redirect?code=…&state=<s>   (all Google params kept)
 5. PocketBase's own oauth2-redirect page hands the code to the SDK via realtime (unchanged)
 6. POST /api/collections/users/auth-with-oauth2 {provider:"google", redirectURL:<site>} ──► agent
         agent sets redirectURL = https://auth.example.com/google/callback ──► PocketBase
 7. PocketBase exchanges the code with Google directly (redirect_uri matches) and logs the user in
```

Facts this relies on (checked 2026-10-14):

- JS SDK 0.28.1 (`authWithOAuth2`) opens `provider.authURL + <site>/api/oauth2-redirect`,
  then replaces `state` with its realtime client ID, then calls
  `authWithOAuth2Code(…, redirectURL = <site>/api/oauth2-redirect)`.
- PocketBase 0.40.4 sends `redirectURL` from the request body to Google in the code exchange.
- The agent runs on the host and reaches a site container at its `siteio-network`
  IP (checked on the `siteio` server: `curl http://172.18.0.8:8090/api/health` → 200).

## Components

### 1. Reserved name `auth` (`tenants.ts`, `storage.ts`, `app-storage.ts`)

- Add one `RESERVED_NAMES = ["api", "auth"]` constant in `tenants.ts`.
- `assertValidNewName`, `TenantRegistry.resolve`, `SiteStorage` and `AppStorage`
  use it instead of their 3 copies of the `name === "api"` check.
- As a result, `siteFromHost("auth.<base>")` returns `null`, so `auth.<base>` is
  never treated as a site.

### 2. Traefik routing (`traefik.ts`)

- **Auth hosts:** a new `auth-router` with `Host(auth.<base>)` for every scope.
  It uses the agent's existing `api-service` and the `letsencrypt` resolver.
  `TenantRegistry.authHosts()` lists them. When a tenant is added, the agent
  refreshes them the same way it refreshes the API hosts today (`setApiHosts`).
- **Interception:** extend the existing reserved-path router (`mcp-router`,
  priority 1000, any host) with
  `PathRegexp(^/api/collections/[^/]+/auth-(methods|with-oauth2)$)`.
  Apps keep priority 2000, so app hosts are not affected. Update the router's
  comment so it no longer describes itself as MCP-only.

### 3. PocketBase interceptor (new `src/lib/agent/oauth-relay.ts`)

The agent hands it requests for the 2 paths above. It finds the site with the
existing `hostContext(host)` (platform hosts and custom domains). An unknown host
gets a 404.

- **Forward:** send the request to the site's PocketBase at
  `http://<container-ip>:8090` with the method, body and headers unchanged, plus
  `X-Forwarded-For/Proto/Host`. Ask PocketBase for an uncompressed response.
  The container IP comes from `docker inspect` on `siteio-network`. It's cached
  per container and looked up again after a connection error. Tests inject a
  fixed backend URL (server `hooks`), like `chatExecutor`.
- **`GET …/auth-methods`:** in `oauth2.providers[]`, find the entry named
  `google` whose `authURL` starts with `https://accounts.google.com/o/oauth2/v2/auth`.
  Swap that prefix for `https://auth.<site-base>/google/authorize` and keep the
  query unchanged. Every other provider and field is left as is. A response that
  isn't JSON, or isn't 200, is passed through unchanged.
- **`POST …/auth-with-oauth2`:** if the JSON or form body has `provider: "google"`,
  set `redirectURL` to `https://auth.<site-base>/google/callback`. Any other body
  is passed through unchanged.
- If PocketBase can't be reached: 502 with a JSON error, in PocketBase's error shape.

`<site-base>` is the base domain of the scope that owns the site:
`TenantRegistry.baseDomain(ownerOf(key))`. This also holds for custom domains.

### 4. Bouncer on `auth.<base>` (same module)

Any request whose host is `auth.<base>` is handled here, before the API-host
check. Other paths get a 404.

The list of allowed hosts for a scope is every site in that scope: its platform
host plus its custom domains, read live from `SiteStorage`, so it never goes
stale.

- **`GET /google/authorize`:** requires `redirect_uri` and `state`.
  `redirect_uri` must be `https`, have no user info and no port, and its host
  must be in the allowed list. Any path is accepted, so manual SDK flows keep
  working. The response is a 302 to Google with every other parameter kept,
  `redirect_uri` set to the callback URL, and
  `state = base64url(JSON {r: redirect_uri, s: state})`.
- **`GET /google/callback`:** decodes `state` and checks `r` against the
  allowed list again, so `state` doesn't need a signature. The response is a 302
  to `r` with Google's parameters added (`code`, `scope`, `authuser`, `prompt`,
  or `error` and `error_description`) and `state = s`. Any query already in `r`
  is kept.
- If `state` is malformed or the host is not allowed, the bouncer returns a
  plain 400 page and never redirects. It never redirects to a host outside the
  scope either.

### 5. Docs

- `CLAUDE.md` Features: one line about the shared Google redirect.
- `skill-content.ts` (the site skill): Google login is set up as usual, and the
  only redirect URI to register is `https://auth.<domain>/google/callback`.
- Release note: **before** upgrading an agent, add the callback URI to every
  Google client its sites use.

## Out of scope

- Other providers (GitHub, Microsoft, Apple's `form_post`, …).
- `siteio sites dev` (local dev has no agent; register a localhost redirect URI as usual).
- Docker apps.
- Flows that don't use the PocketBase API (for example custom OAuth in `pb_hooks`).

## Risks

- **Google login now needs the agent running.** Other site traffic doesn't.
- **PocketBase API shape:** this relies on the documented `auth-methods` and
  `auth-with-oauth2` fields. The pinned version plus tests catch changes on upgrade.
- **Switch-over:** a Google client that doesn't list the callback URI stops
  working as soon as the agent is upgraded.

## Testing (adversarial)

- **Reserved name:** `auth` is refused for sites, apps, renames and tenant sites,
  and `siteFromHost("auth.<base>")` is `null`.
- **Bouncer `authorize`:** these are refused with no redirect:
  - a foreign host
  - `http`
  - user info (`https://x@evil.com`)
  - a suffix trick (`blog.example.com.evil.com`)
  - a port
  - a tenant site asked for on the primary `auth` host, or the reverse
  - missing `state`
  - missing `redirect_uri`
  - a malformed URL

  A custom domain is accepted. All other parameters reach Google unchanged.
- **Bouncer `callback`:** tampered `state` (bad base64, bad JSON, foreign `r`)
  gets a 400. Google's `error=access_denied` is passed to the site. Any query
  already in `r` is kept.
- **Interceptor:** only Google's `authURL` changes. Other providers, a 4xx
  response, non-JSON, a compressed upstream response and a missing `oauth2` key
  all pass through. `auth-with-oauth2` for another provider is untouched. A form
  body is rewritten. PocketBase down gives a 502. An unknown host gets a 404.
- **Traefik config:** `auth-router` covers the primary and tenant `auth` hosts
  and updates when a tenant is added. The interception paths are on the
  reserved-path router, and app routers still outrank it.
- **End-to-end:** a real `AgentServer` plus a fake PocketBase backend (injected URL) run
  steps 1–7. Google is not called: the test checks each redirect's `Location`
  and the `redirectURL` that reaches the fake backend.
