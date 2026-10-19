import type { MeInfo, User } from "../../types.ts"
import { ValidationError } from "../../utils/errors.ts"
import { CLEAR_SESSION_COOKIE, sessionCookie, userFitsHost, type Auth } from "./auth.ts"
import { errorResponse, jsonResponse, readJson } from "./http.ts"
import { RateLimiter } from "./rate-limit.ts"
import type { Scope, TenantRegistry } from "./tenants.ts"
import type { UserStore } from "./user-store.ts"

// Password login for the admin UI, the caller's own account (/me) and, for the
// admin and tenant owners, managing users (/users). Works for every kind of
// key: the god key acts as the admin, a tenant key as its tenant's owner.
export class UserRoutes {
  // Failed password checks (login, or a wrong current password), per client IP.
  private failures = new RateLimiter(10, 60_000)

  constructor(
    private users: UserStore,
    private tenants: TenantRegistry
  ) {}

  // POST /auth/login, unauthenticated, on the API host of `scope`.
  async login(req: Request, scope: Scope, ip: string): Promise<Response> {
    if (this.failures.blocked(ip)) return errorResponse("Too many failed attempts, try again in a minute", 429)
    if (!this.users.hasAdmin()) return errorResponse("No users on this server yet", 409)
    const body = await readJson(req)
    const user = await this.users.verifyPassword(body?.username, body?.password)
    if (!user || !userFitsHost(user, scope)) {
      this.failures.hit(ip)
      return errorResponse("Invalid username or password", 401)
    }
    const { key, secret } = this.users.addKey(user.username, "session", "browser")
    return jsonResponse(this.meOf({ kind: "user", user, key }), 200, { "Set-Cookie": sessionCookie(secret) })
  }

  // Routes for an authenticated caller, or null when `path` isn't one of them.
  async handle(path: string, req: Request, auth: Auth, ip: string): Promise<Response | null> {
    if (path === "/auth/logout" && req.method === "POST") {
      if (auth.kind === "user" && auth.key.kind === "session") this.users.revokeKey(auth.user.username, auth.key.id)
      return jsonResponse({ loggedOut: true }, 200, { "Set-Cookie": CLEAR_SESSION_COOKIE })
    }
    if (path === "/me" && req.method === "GET") return jsonResponse(this.meOf(auth))
    if (path === "/me/password" && req.method === "POST") return this.changeOwnPassword(req, auth, ip)
    if (path === "/me/keys" && req.method === "GET") {
      return jsonResponse(auth.kind === "user" ? this.users.activeKeys(auth.user).map((k) => this.users.keyInfo(k)) : [])
    }
    if (path === "/me/keys/current" && req.method === "DELETE") {
      const revoked = auth.kind === "user" && this.users.revokeKey(auth.user.username, auth.key.id)
      return jsonResponse({ revoked })
    }
    const own = path.match(/^\/me\/keys\/(key_[0-9a-f]+)$/)
    if (own && req.method === "DELETE") {
      if (auth.kind !== "user" || !this.users.revokeKey(auth.user.username, own[1]!)) return errorResponse("Key not found", 404)
      return jsonResponse({ revoked: true })
    }
    return null
  }

  private meOf(auth: Auth): MeInfo {
    if (auth.kind === "user") {
      return { username: auth.user.username, role: auth.user.role, tenant: auth.user.tenant ?? null, currentKeyId: auth.key.id }
    }
    if (auth.kind === "tenant") return { username: null, role: "owner", tenant: auth.tenant.domain, currentKeyId: null }
    return { username: null, role: "admin", tenant: null, currentKeyId: null }
  }

  private async changeOwnPassword(req: Request, auth: Auth, ip: string): Promise<Response> {
    if (auth.kind !== "user") return errorResponse("Only a user account has a password", 400)
    if (this.failures.blocked(ip)) return errorResponse("Too many failed attempts, try again in a minute", 429)
    const body = await readJson(req)
    if (typeof body?.new !== "string") return errorResponse("'new' is required")
    if (!(await this.users.verifyPassword(auth.user.username, body.current))) {
      this.failures.hit(ip)
      return errorResponse("Current password is wrong", 403)
    }
    try {
      await this.users.setPassword(auth.user.username, body.new, auth.key.kind === "session" ? auth.key.id : undefined)
    } catch (err) {
      if (err instanceof ValidationError) return errorResponse(err.message, 400)
      throw err
    }
    return jsonResponse({ changed: true })
  }
}
