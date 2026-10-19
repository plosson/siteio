# Users and device login — design

Status: draft for review (2026-10-19)

## Goal

Logging in a new machine should be as easy as with agentio:

    siteio login api.example.com
    → prints a code, opens https://api.example.com/ui#authorize=BCDF-2345
    → the person logs in with a username and password, checks the code, approves
    → the CLI has its own key

This must also work for tenants (`siteio login api.friend.fr`).

Today the only way is to copy a login token (`siteio login -t …`) or an API key
to every machine. siteio has no credential a human can type: the admin UI logs
in with the API key itself.

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Main problem | Easier onboarding of a new machine |
| 2 | Credential model | Users with passwords; every user gets their own keys, never the god or tenant key |
| 3 | Admin | One admin per server, whose password is set at install |
| 4 | Roles | `admin` (whole server), `owner` (one tenant, manages its members), `member` (works in one scope) |
| 5 | Member rights | Every site and app in their scope, with tenant-level restrictions |
| 6 | Keys | One key per approved login (per machine), revocable on its own |
| 7 | Admin's CLI | Gets its own admin user key, like any other user |
| 8 | Existing credentials | God key, tenant keys (`ten_…`), share codes and `-t` tokens keep working unchanged |
| 9 | Login host | A user logs in on the API host of their own scope (`api.<their domain>`) |
| 10 | User management | Admin UI and CLI (`siteio users …`), same agent routes |
| 11 | Approach | Port agentio's device login into siteio (no shared package, no RFC 8628) |
| 12 | Chat editor | Main-domain members get the site chat and `sites edit`; tenants still don't |

## 1. User store and roles

New `src/lib/agent/user-store.ts`, class `UserStore`, shaped like `GrantStore`:
one JSON file per user at `<dataDir>/users/<username>.json`. The folder is
`0700` and each file `0600`.

```ts
interface User {
  username: string            // unique per server; same rule as site names
  role: "admin" | "owner" | "member"
  tenant?: string             // tenant domain; absent = main domain
  passwordHash: string        // Bun.password (argon2id)
  createdAt: string
  keys: UserKey[]
}
interface UserKey {
  id: string
  kind: "machine" | "session" // CLI login, or admin UI session
  name: string                // machine name, e.g. "alice@macbook"; "browser" for sessions
  hash: string                // sha256 of the secret; the secret is never stored
  createdAt: string
  expiresAt?: string          // sessions only
}
```

**Keys**
- A user key is `usr_<random>`. `utils/grant-token.ts` gains a prefix parameter
  and generates and hashes it; there is no second generator.
- Lookup is by hash through a cached hash → username index. On every hit the
  store re-reads the user file and checks that the hash is still in
  `user.keys` and not expired, so a revoked key fails at once. The index is
  reset when a user or key is added or removed.
- The secret is shown once: in the device-login poll answer, or in the session
  cookie.
- The store never writes on a read. There is no `lastUsedAt`.

**Usernames**
- Same rule as site names (`NAME_RE` in `tenants.ts`).
- Validated on every `get`, `create` and `delete` before it becomes a path,
  because login reads it from an unauthenticated request.
- Unique per server. "Username taken" therefore reveals that the name exists on
  another tenant. This is accepted.

**Roles**

| Role | Scope | Created by |
|---|---|---|
| `admin` | whole server; exactly one, named `admin`, no tenant | install, or `siteio agent password` |
| `owner` | one tenant (`tenant` required) | admin |
| `member` | main domain or one tenant | admin, or that tenant's owner |

- Code checks `role === "admin"` only, never the username.
- A main-domain user can only be a `member`.
- No route can create a second admin or delete `admin`.

**Admin password**
- `siteio agent install` asks for it on a TTY. Without a TTY, or when
  `--domain` is given (as `siteio server create` does over SSH), it generates
  one and prints it once. `--admin-password <p>` sets it explicitly.
  `siteio server create` shows the generated password in its output.
- `siteio agent password` (on the box) sets or resets it. It creates the
  `admin` user if there isn't one, which is how existing servers get one.

**Lifecycle**
- Deleting a user deletes all of their keys and sessions. Share codes they
  created stay valid (grants don't record a creator); this is accepted.
- `siteio agent tenant remove` deletes that tenant's users, and
  `siteio agent tenant add` deletes any user files left for that domain, so a
  removed tenant's users never come back.
- A password change by the user ends their other sessions. A reset by an admin
  or owner ends all of the target's sessions. Machine keys keep working in
  both cases.

**Concurrency**: none needed. The agent is single-threaded and writes
synchronously, and it only writes user files on user actions (create, delete,
password, key add or revoke).

## 2. Authorization

`authenticate()` in `server.ts` checks `usr_` keys first, then the existing
credentials. Without an `X-API-Key`, it reads the session cookie (section 3).
It returns the same `kind` values as today, plus `{ kind: "user", user }`.

| Key | Accepted on | The request runs as |
|---|---|---|
| god key | main API host | admin (unchanged) |
| `ten_…` | its tenant's API host | tenant (unchanged) |
| share code | any host | one site (unchanged) |
| `usr_…`, admin | main API host only | admin: the god key's full route table |
| `usr_…`, owner or member | the API host of the user's scope only | that scope, through the allowlist |

A user key on the wrong host, or a user whose tenant is not in the registry,
gets 401.

**Caller instead of scope.** Today `scope === null` means both "main domain"
and "operator who sees and may do everything". Handlers now get
`{ scope, admin }`, and **every operator exemption is keyed on `admin`, not on
`!scope`**:
- `tenantAppViolation` (`server.ts` ~699): compose apps, host-path volumes,
  `file://` and ssh git, denied env keys.
- `customDomainsViolation` (~744): hostnames on the main domain.
- `handleGetAgentInfo` (~1555): the operator view (data dir, email, ports,
  server-wide counts).
- `TenantRegistry.nameIn` / `inScope` (`tenants.ts` ~97-111), used by every
  list and info view: a non-admin caller on the main domain sees only keys
  without a tenant.
- App creation with a legacy name (~828) stays admin-only.

The god key is `admin: true`, a tenant key `admin: false` with its tenant, so
nothing changes for them.

**Allowlist.** Owners and members, on the main domain too, go through the
tenant allowlists (`TENANT_ROUTE`, `TENANT_APP_ROUTE`) and the "no `--` in
paths" check. Main-domain members may run apps (the main scope always allows
them), under the restrictions above. Main-domain members also get
`/sites/:n/chat`, `/chat/stop` and `/sites/:n/edit-link`, so they get the
chat editor and `sites edit`. Tenants don't (`chatEnabled` is `!scope`, which
is unchanged).

**User routes**

| Caller | May manage |
|---|---|
| admin (or god key) | every user except deleting `admin`; resets `admin`'s password only through `/me/password` or on the box |
| owner (or that tenant's `ten_` key) | members of their own tenant |
| member | no one |

- `POST /users` refuses `role: "admin"`; only the admin may create an owner.
- A user outside the caller's reach answers 404, not 403.
- Every user can see their own keys (with `kind`, never the hash), revoke
  them, and change their own password.
- `/me` with a god or tenant key answers a synthetic identity
  (`{ username: null, role: "admin" | "owner", tenant }`) and has no keys.

**Identity.** `requestUser(req)` (`server.ts` ~297) takes the caller. For a user
key, the name recorded for deploy history, the pager and ranking is the
username, checked by the agent, and `X-Siteio-User` is ignored. Older key
types still use the header.

## 3. Password login to the admin UI

- `/ui` asks for a username and password, with a "Use API key" link to the
  current API key form (`ui.js` ~117-140) for servers without an admin yet.
  `siteio ui` still opens it with the CLI's key (`?key=`).
- **`POST /auth/login`** `{ username, password }` on an API host:
  - Checks with `Bun.password.verify`; an unknown user is checked against a
    fixed placeholder hash so timing doesn't reveal usernames.
  - The user's scope must match the host.
  - Rate limit: 10 failed attempts per minute per client IP, then 429. The IP
    comes from Traefik's forwarded header, trusted only from Traefik, as in
    `analytics/client-ip.ts`. There is no per-username limit, so nobody can
    lock `admin` out.
  - Every failure answers "Invalid username or password".
- **Session** = a `UserKey` with `kind: "session"`, `expiresAt` 7 days later,
  sent as cookie `siteio_session` with `HttpOnly; Secure; SameSite=Strict;
  Path=/`. Expired sessions are removed at the next login or key change of
  that user.
- **Cross-site requests.** `SameSite=Strict` does not protect the API host
  from the server's own sites (`blog.example.com` is the same site as
  `api.example.com`). A request authenticated by the cookie must also send
  `X-Siteio-UI: 1`. A form can't add it, and a cross-origin `fetch` that adds
  it needs a preflight, which the API host never answers (no CORS headers).
  An `X-API-Key` header always wins over the cookie.
- **`POST /auth/logout`** deletes the session key and clears the cookie.
- **Account page**: change own password (`POST /me/password`
  `{ current, new }`), list and revoke own keys.
- **Users page** (admin and owners): add, delete, reset password. The admin
  sees every user and picks the scope; an owner sees only their tenant.

## 4. Device login

Ported from agentio (`src/daemon/device-auth.ts`, `src/auth/device-login.ts`).

**CLI**
1. `POST /device` `{ name, replaces? }`, unauthenticated. `name` is the
   machine name (`--name`, else `user@hostname`). Answer:
   `{ userCode: "BCDF-2345", deviceCode, expiresIn: 600, interval: 3 }`.
2. Prints the code and `https://<api host>/ui#authorize=<code>`, opens the
   browser when it can.
3. Polls `POST /device/token` `{ deviceCode }` every 3 s. Answer: `pending`,
   `denied`, or `approved` with `{ key, username }`, handed out once.
4. Saves the server with that key and the username (per server; the global
   `username` setting is never changed), and switches to it.

**Agent**
- `/device` and `/device/token` share one rate limit: 40 per minute per client
  IP (same IP source as login).
- Pending requests in memory only: at most 100, 10-minute expiry. Expired ones
  are removed when a new request starts. User codes are unique among pending
  requests. A restart forgets them; the CLI says to run `siteio login` again.
- Each request records the scope of the host it started on and the requester's
  IP. Only a user of that scope can approve it.
- Codes use agentio's alphabet without look-alikes; the UI accepts any case,
  with or without the dash.
- Approval is synchronous (no `await` between checking and deciding), so
  agentio's `deciding` flag is not needed.

**Approval**
- `/ui#authorize=<code>` shows the login screen if there is no session, then
  the code, machine name, requester IP and age of the request, with the warning
  "Approve only a code shown in your own terminal".
- `POST /device/approve` creates a machine `UserKey` for the logged-in user,
  named after the machine. `POST /device/deny` ends the request. Both need the
  session cookie and `X-Siteio-UI`.

**Same machine again** (`--relogin`): the CLI sends its current key for that
server as `replaces`. The agent keeps only a proof of it (key id and hash). On
approval it revokes that key only if it is a `usr_` key of the approving user;
otherwise it ignores it.

**`siteio login`**

The argument is normalized with `extractDomain` (so `api.example.com` and
`example.com` name the same saved server). Partial matching applies only to
arguments without a dot.

| Command | Behaviour |
|---|---|
| `siteio login <host>`, server already saved | switches to it (unchanged) |
| `siteio login <host> --relogin`, server already saved | device login, replacing this machine's key |
| `siteio login <host>`, new server | device login |
| `siteio login`, no argument | server picker as today; "Add new server" asks for the URL, then device login, falling back to the API key prompt if the agent has no `/device` |
| `-t <token>`, `--api-url` + `--api-key` | unchanged |

**`siteio logout`** calls `DELETE /me/keys/current` only when the saved key is a
`usr_` key, then removes the server locally. If the agent can't be reached, it
removes it locally with a warning.

**Older agents**: no `/device` → "This server doesn't offer device login;
update the agent or use `-t`".

## 5. CLI, routes, rollout

**CLI** (JSON on stdout, readable text on stderr)

| Command | Who |
|---|---|
| `siteio users list` | admin (all), owner (their tenant) |
| `siteio users add <name> [--role owner\|member] [--tenant <domain>]` | admin; owner adds members only, tenant implied |
| `siteio users remove <name>` | same |
| `siteio users reset-password <name>` | same |
| `siteio users keys`, `siteio users revoke-key <id>` | own keys only |
| `siteio agent password` (on the box) | sets or resets the admin password |

`add` and `reset-password` generate the password and print it once. Users
change their own password in the UI.

**Routes** (API host)

| Route | Auth |
|---|---|
| `POST /auth/login`, `POST /device`, `POST /device/token` | none (rate-limited) |
| `POST /auth/logout`, `POST /device/approve`, `POST /device/deny` | session cookie + `X-Siteio-UI` |
| `GET /me` → `{ username, role, tenant, currentKeyId }` | any user, god or tenant key |
| `POST /me/password`, `GET /me/keys`, `DELETE /me/keys/:id`, `DELETE /me/keys/current` | user key or session |
| `GET`/`POST /users`, `DELETE /users/:name`, `POST /users/:name/password` | admin, owner, god or tenant key |

**Rollout**
1. Minor release; nothing existing changes.
2. On each server: `siteio update`, `agent restart`, `siteio agent password`.
3. With no admin yet, login and device login answer "no users on this server
   yet"; everything else works as before.
4. Docs: a feature line in `CLAUDE.md`; the site skill's login instructions
   become `siteio login api.<domain>`.

**Order of work**
- Part 1: user store, authorization (caller `{ scope, admin }`), UI login,
  `users` commands, `agent password`, install changes. Shipped and tested
  alone.
- Part 2: device login, `login` and `logout` changes.

## Out of scope

- Per-site permissions for members.
- More than one admin.
- Changing your own password from the CLI.
- Single sign-on (Google, etc.) for siteio users.
- Revoking share codes when the user who created them is deleted.

## Testing (adversarial, real `AgentServer`)

- **Keys**: a member key on `/tenants`, agent config or a tenant host is
  refused; a tenant user's key on the main host or another tenant is refused;
  the admin key on a tenant host is refused; a revoked key is refused at once
  with a warm cache; a user of a removed tenant is refused, and stays refused
  after the domain is added again.
- **Operator exemptions**: a main-domain member can't create a compose app,
  mount a host path, clone `file://` or ssh, set a denied env key, claim a
  main-domain hostname for an app, or get the operator view of `GET /agent`.
- **Listing**: a main-domain member never sees tenant sites or apps in lists or
  counts; a `--` path is refused.
- **Chat**: a main-domain member reaches chat and `edit-link`; a tenant user
  doesn't.
- **Login**: unknown user and wrong password answer the same; 10 failures from
  one IP answer 429 while another IP still logs in; `../` or `/` in a username
  is refused; a tenant user on the main host is refused.
- **Sessions**: a cookie request without `X-Siteio-UI` is refused; an expired
  session is refused; a password change ends other sessions but not machine
  keys.
- **Device login**: a code is approved once and its key handed out once; an
  expired code is refused; a tenant-host code can't be approved by a
  main-domain user, and the reverse; the 101st pending request is refused;
  approval without a session is refused; `replaces` revokes the old key of the
  same user, and is ignored for another user's key or a god key.
- **Users**: `POST /users` with `role: admin` is refused; nobody can delete
  `admin`; an owner can't create an owner, add to another tenant, or see,
  reset or delete another owner or a main-domain user (404); a member can't
  manage anyone.
- **CLI**: `siteio login api.example.com` switches to a saved `example.com`;
  `siteio login example.com` doesn't switch to a saved `blog.example.com`;
  `logout` with a god key or share code doesn't call the agent; a device login
  doesn't change the global `username`; `agent install` without a TTY doesn't
  prompt.
