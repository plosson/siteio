# Tenant platform paths switch and wildcard tenant certificates: design

Date: 24 Oct 2026
Requested by: Nino, which sits on top of siteio as a branded product. Pierre delegated the design choices; Claude's calls are marked *(Claude's call)*.

## Goal

1. **A switch per tenant that turns off siteio's platform paths** on that tenant's site hosts. Today `/mcp*`, `/_siteio/*`, `/.well-known/oauth-authorization-server*` and `/.well-known/oauth-protected-resource*` answer on every site host, so anyone visiting `bbq.k7f2.mynino.app/mcp` sees siteio's per-site editor and its name. A product built on siteio, like Nino, needs those paths to fall through to the site itself.
2. **One wildcard certificate per tenant** when the agent uses the DNS-01 challenge. Then a new site under a tenant is served with a valid certificate at once, without its own Let's Encrypt request. This also stops a busy tenant domain from hitting the limit of 50 certificates per week.

## 1. `platformPaths` per tenant

- **New field:** `Tenant.platformPaths?: boolean`. Absent means on (today's behaviour). Only `false` is stored.
- **`POST /tenants`** accepts `platformPaths` (boolean, optional). A value that isn't a boolean returns 400 `'platformPaths' must be true or false`. The response and `GET /tenants` summaries include `platformPaths: boolean`.
- **On-box CLI:** `siteio agent tenant add <domain> --no-platform-paths`.
- **Traefik:** the host-independent `mcp-router` rule becomes `(<existing PathPrefix clauses>) && !HostRegexp(...)`, with one regex per tenant that has the paths off. The regex is `^(.+\.)?<escaped tenant domain>$`.
  - With no such tenant, the rule is exactly today's.
  - `TraefikManager` gets `setPlatformOffDomains(domains)`, called wherever `setApiHosts` is called: the constructor, add tenant and remove tenant. Both setters rewrite `dynamic.yml`.
- **Defence in depth:** `liveHostContext` returns null, so the response is a JSON 404 from the existing branch, when the resolved context's scope has `platformPaths === false`. This covers the `/mcp`, OAuth, upload and `/_siteio` handling even if Traefik routes such a request to the agent, for example during the short window before `dynamic.yml` is reloaded.
- **Custom domains** of a tenant's site are covered by the agent-side check, because the scope is the owner. They are not covered by the Traefik exclusion, so they reach the agent and get the 404. *(Claude's call: acceptable, since custom domains aren't used by Nino yet.)*
- **Existing tenants are not changed.** The flag is set only when a tenant is added. There is no endpoint to edit it. *(Claude's call: YAGNI.)*

## 2. Wildcard certificate per tenant (DNS-01 only)

- **When:** the agent's ACME challenge is `dns`.
- **What:** the file-provider `api-router` carries `tls.domains` with one entry per tenant: `{ main: "<tenant>", sans: ["*.<tenant>"] }`.
  - Traefik requests these as soon as `dynamic.yml` lists them, so the wildcard exists before the tenant's first site.
  - A site router with `certResolver` whose host is covered by an existing certificate does not start a new request in Traefik v3.
- **Other challenges (`http`, `tls`):** nothing changes. A wildcard can't be issued without DNS-01.
- **YAML fix:** the `toYaml` helper must quote string items inside arrays, because a bare `*.x` is a YAML alias. Fix the array-of-scalars branch to use `JSON.stringify`, as scalar values already do.
- **Not covered:** deeper names (`a.b.tenant`) and custom domains keep their own certificates.

## Tests

- **Unit tests in `traefik-manager.test.ts`:**
  - The rule is unchanged with no opted-out tenants.
  - It contains one `!HostRegexp` per opted-out tenant, with the dots escaped.
  - A tenant whose domain is a suffix of another does not overmatch. For example, `ab.app` vs `b.app`: `x.ab.app` must not be excluded by `b.app`'s regex. The `(.+\.)?` plus anchor handles this.
  - `tls.domains` is present only for `dns`, and is quoted correctly as YAML.
- **API tests in `tenants.test.ts`:**
  - The flag is accepted, refused when not a boolean, persisted, and listed.
  - `/mcp`, `/.well-known/oauth-protected-resource` and `/_siteio/edit` on a site host of an opted-out tenant return 404.
  - The same paths on another tenant's site still work.
  - Removing the tenant drops it from the exclusion list.

## Release

Feature PR, then a version bump to 1.53.0 in its own PR, then the tag `v1.53.0` (see `CLAUDE.md` Releasing).
