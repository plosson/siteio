# OAuth Enforcement Design

## Overview

Implement active OAuth protection for siteio sites and apps using oauth2-proxy and Traefik forward auth middleware.

## Current State

- OAuth configuration storage exists (`oauth-config.json`)
- Per-site/app OAuth restrictions exist (`allowedEmails`, `allowedDomain`, `allowedGroups`)
- `/auth/check` endpoint validates authorization based on email headers
- Groups system for access control
- oauth2-proxy container configuration exists but is not started

## Goals

- **Opt-in protection**: Only sites/apps with explicit `oauth` config are protected
- **Seamless UX**: Visit site → redirect to login → return with access
- **Clear error handling**: 403 page shows email + logout link for wrong account
- **Fail closed**: Auth service down = access denied (502), not open access

## Architecture

### Request Flow (Protected Site)

```
User visits mysite.example.com
         ↓
      Traefik
         ↓
    ┌─────────────────────────────────────┐
    │ Middleware 1: "oauth2-proxy-auth"   │
    │ forwardAuth → oauth2-proxy:4180     │
    │                                     │
    │ No cookie? → 302 to OIDC login      │
    │ Valid cookie? → 200 + email header  │
    └─────────────────────────────────────┘
         ↓
    ┌─────────────────────────────────────┐
    │ Middleware 2: "siteio-authz"        │
    │ forwardAuth → agent:3000/auth/check │
    │                                     │
    │ Email allowed? → 200                │
    │ Email not allowed? → 403 + message  │
    └─────────────────────────────────────┘
         ↓
    Site/App serves content
```

### Unprotected Sites

No middlewares applied - direct routing to service.

### Auth Subdomain

`auth.{domain}` routes to oauth2-proxy:

| Path | Purpose |
|------|---------|
| `/oauth2/callback` | OIDC provider redirects here after login |
| `/oauth2/sign_out` | Logout (clears cookie), accepts `?rd=` for redirect |
| `/oauth2/userinfo` | (optional) Show current session info |

## Traefik Middleware Configuration

```yaml
http:
  middlewares:
    # Stage 1: Authentication (login flow)
    oauth2-proxy-auth:
      forwardAuth:
        address: "http://siteio-oauth2-proxy:4180/oauth2/auth"
        trustForwardHeader: true
        authResponseHeaders:
          - "X-Auth-Request-Email"
          - "X-Auth-Request-User"
          - "X-Auth-Request-Groups"

    # Stage 2: Authorization (per-site access check)
    siteio-authz:
      forwardAuth:
        address: "http://siteio-agent:3000/auth/check"
        trustForwardHeader: true
```

### Route Examples

```yaml
http:
  routers:
    # UNPROTECTED site - no middlewares
    site-public-blog:
      rule: "Host(`blog.example.com`)"
      service: nginx

    # PROTECTED site - both middlewares chained
    site-private-admin:
      rule: "Host(`admin.example.com`)"
      middlewares:
        - oauth2-proxy-auth
        - siteio-authz
      service: nginx
```

## oauth2-proxy Configuration

```
--provider=oidc
--oidc-issuer-url={issuerUrl}
--client-id={clientId}
--client-secret={clientSecret}
--cookie-secret={cookieSecret}
--cookie-domain=.{domain}
--cookie-secure=true
--whitelist-domain=.{domain}
--redirect-url=https://auth.{domain}/oauth2/callback
--email-domain=*
--upstream=static://200
--skip-provider-button=true
--reverse-proxy=true
--set-xauthrequest=true
```

## 403 Forbidden Page

When `/auth/check` denies access, return styled HTML:

```
Access Denied

You're signed in as {email} but this site requires authorization.

[Sign out and try another account]
→ links to: auth.{domain}/oauth2/sign_out?rd={original-url}
```

Implemented as inline HTML string in server.ts (~20 lines).

## User Flows

### Happy Path
1. User visits `mysite.example.com` (protected)
2. No session → redirected to OIDC provider
3. User logs in
4. Redirected back with session cookie
5. `/auth/check` verifies email is allowed → 200
6. User sees site content

### Wrong Account
1. User visits `mysite.example.com` (protected)
2. Logs in with `wrong@gmail.com`
3. `/auth/check` sees email not in allowed list → 403
4. User sees: "Access Denied. You're signed in as wrong@gmail.com..."
5. Clicks "Sign out and try another account"
6. Cookie cleared, redirected back, can try different account

### Logout
1. User visits `auth.example.com/oauth2/sign_out?rd=https://mysite.example.com`
2. oauth2-proxy clears session cookie
3. User redirected to `mysite.example.com`
4. No cookie → prompted to log in again

## Implementation Changes

### Files to Modify

1. **`src/lib/agent/traefik.ts`** - TraefikManager
   - Start oauth2-proxy container when OAuth is configured
   - Add `auth.{domain}` route pointing to oauth2-proxy
   - Define the two global middlewares (when OAuth configured)
   - Apply middlewares to protected site/app routes

2. **`src/lib/agent/server.ts`** - `/auth/check` endpoint
   - Return styled 403 HTML page (not just status code)
   - Include user's email and logout link
   - Keep returning 200 for authorized requests

3. **`src/config/oauth.ts`** - Minor addition
   - Add helper to check if OAuth is fully configured

### Files Unchanged
- Storage classes (already store `oauth` config)
- CLI commands (already set `oauth` on sites/apps)
- Group management (already works)

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| OAuth configured after sites exist | Regenerate Traefik config, protected sites get middlewares |
| OAuth removed/disabled | Stop oauth2-proxy, regenerate config without middlewares |
| oauth2-proxy crashes | Traefik forwardAuth fails → 502 (fail closed) |
| `/auth/check` unreachable | Traefik forwardAuth fails → 502 (fail closed) |
| Cookie expires mid-session | oauth2-proxy redirects to login (transparent) |
| OIDC provider down | Login fails at provider level |

## Out of Scope

- Caching auth decisions (every request checks fresh)
- Refresh token management (oauth2-proxy handles internally)
- Multiple OIDC providers (one provider per siteio instance)
- Startup validation of OIDC connectivity
