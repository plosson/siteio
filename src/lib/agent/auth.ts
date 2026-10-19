import type { ShareGrant, Tenant, User, UserKey } from "../../types.ts"
import type { Scope } from "./tenants.ts"
import { SESSION_TTL_MS } from "./user-store.ts"

// Who a request authenticated as. See AgentServer.authenticate.
export type Auth =
  | { kind: "god" }
  | { kind: "tenant"; tenant: Tenant }
  | { kind: "grant"; grant: ShareGrant }
  | { kind: "user"; user: User; key: UserKey }

// A user works only on the API host of its own scope: the admin and main-domain
// members on the main one, a tenant's users on that tenant's. A user of a
// tenant this agent no longer has fits no host (that host isn't an API host).
export function userFitsHost(user: User, scope: Scope): boolean {
  return (scope?.domain ?? null) === (user.tenant ?? null)
}

// The admin UI session. Host-only (no Domain): it goes to api.<domain> and
// never to the server's sites.
export const SESSION_COOKIE = "siteio_session"
const COOKIE_ATTRS = "Path=/; HttpOnly; Secure; SameSite=Strict"

export function sessionCookie(secret: string): string {
  return `${SESSION_COOKIE}=${secret}; ${COOKIE_ATTRS}; Max-Age=${SESSION_TTL_MS / 1000}`
}

export const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`
