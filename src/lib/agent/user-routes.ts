import type { MeInfo, User } from "../../types.ts"
import { ValidationError } from "../../utils/errors.ts"
import { CLEAR_SESSION_COOKIE, sessionCookie, userFitsHost, type Auth } from "./auth.ts"
import { errorResponse, jsonResponse, readJson } from "./http.ts"
import { RateLimiter } from "./rate-limit.ts"
import type { Scope, TenantRegistry } from "./tenants.ts"
import { generatePassword, type UserStore } from "./user-store.ts"

// Whom a caller may manage: every user, the members of one tenant, or no one.
type Reach = { all: true } | { tenant: string } | null

// Password login for the admin UI, the caller's own account (/me) and, for the
// admin and tenant owners, managing users (/users). Works for every kind of
// key: the god key acts as the admin, a tenant key as its tenant's owner.
export class UserRoutes {
  // Password checks (login, or a current password) per client IP, counted
  // before the check and given back when it passes: 10 failures a minute.
  private failures = new RateLimiter(10, 60_000)

  constructor(
    private users: UserStore,
    private tenants: TenantRegistry
  ) {}

  // POST /auth/login, unauthenticated, on the API host of `scope`.
  async login(req: Request, scope: Scope, ip: string): Promise<Response> {
    if (this.failures.blocked(ip)) return errorResponse("Too many failed attempts, try again in a minute", 429)
    if (!this.users.hasAdmin()) return errorResponse("No users on this server yet", 409)
    // Login CSRF: a cross-site form can post text/plain but can't add this header.
    if (req.headers.get("X-Siteio-UI") !== "1") return errorResponse("Invalid username or password", 401)
    if (!this.failures.tryHit(ip)) return errorResponse("Too many failed attempts, try again in a minute", 429)
    const body = await readJson(req)
    const user = await this.users.verifyPassword(body?.username, body?.password)
    if (!user) return errorResponse("Invalid username or password", 401)
    if (!userFitsHost(user, scope)) {
      // The password was right: tell the person where this account signs in. Still a counted attempt.
      const domain = user.tenant ?? this.tenants.primaryDomain
      return errorResponse(`This account belongs to ${domain} — sign in at https://api.${domain}/ui`, 401)
    }
    this.failures.undo(ip)
    const { key, secret } = this.users.addKey(user.username, "session", "browser")
    return jsonResponse(this.meOf({ kind: "user", user, key }), 200, { "Set-Cookie": sessionCookie(secret) })
  }

  // Routes for an authenticated caller, or null when `path` isn't one of them.
  async handle(path: string, req: Request, auth: Auth, ip: () => string): Promise<Response | null> {
    if (path === "/auth/logout" && req.method === "POST") {
      if (auth.kind === "user" && auth.key.kind === "session") this.users.revokeKey(auth.user.username, auth.key.id)
      return jsonResponse({ loggedOut: true }, 200, { "Set-Cookie": CLEAR_SESSION_COOKIE })
    }
    if (path === "/me" && req.method === "GET") return jsonResponse(this.meOf(auth))
    if (path === "/me/password" && req.method === "POST") return this.changeOwnPassword(req, auth, ip())
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
    if (path === "/users" || path.startsWith("/users/")) return this.manage(path, req, this.reachOf(auth), auth)
    return null
  }

  private reachOf(auth: Auth): Reach {
    if (auth.kind === "god") return { all: true }
    if (auth.kind === "tenant") return { tenant: auth.tenant.domain }
    if (auth.kind === "user" && auth.user.role === "admin") return { all: true }
    if (auth.kind === "user" && auth.user.role === "owner" && auth.user.tenant) return { tenant: auth.user.tenant }
    return null
  }

  private async manage(path: string, req: Request, reach: Reach, auth: Auth): Promise<Response> {
    if (!reach) return errorResponse("Not found", 404)
    // An owner reaches its tenant's members; anyone else is "not found" to it.
    const reaches = (u: User) => "all" in reach || (u.tenant === reach.tenant && u.role === "member")

    if (path === "/users" && req.method === "GET") {
      return jsonResponse(this.users.list().filter(reaches).map((u) => this.users.toInfo(u)))
    }
    if (path === "/users" && req.method === "POST") return this.createUser(req, reach)

    const m = path.match(/^\/users\/([a-z0-9-]+)(\/password)?$/)
    const target = m ? this.users.get(m[1]!) : null
    if (!m || !target || !reaches(target)) return errorResponse("User not found", 404)

    const self = auth.kind === "user" && auth.user.username === target.username
    if (!m[2] && req.method === "DELETE") {
      if (target.username === "admin") return errorResponse("The admin account can't be deleted", 400)
      if (self) return errorResponse("You can't delete your own account", 400)
      this.users.delete(target.username)
      return jsonResponse({ deleted: target.username })
    }
    if (m[2] && req.method === "POST") {
      if (self) return errorResponse("Change your own password on the Account page", 400)
      const body = await readJson(req)
      const chosen = this.chosenPassword(body)
      if (chosen instanceof Response) return chosen
      const password = chosen ?? generatePassword()
      try {
        await this.users.setPassword(target.username, password)
      } catch (err) {
        if (err instanceof ValidationError) return errorResponse(err.message, 400)
        throw err
      }
      return jsonResponse({ username: target.username, ...(chosen === undefined && { password }), generated: chosen === undefined })
    }
    return errorResponse("Not found", 404)
  }

  // The password a caller chose: undefined when none, or a 400 when it isn't a string.
  private chosenPassword(body: Record<string, unknown> | null): string | undefined | Response {
    if (body?.password === undefined) return undefined
    if (typeof body.password !== "string") return errorResponse("'password' must be a string")
    return body.password
  }

  private async createUser(req: Request, reach: NonNullable<Reach>): Promise<Response> {
    const body = await readJson(req)
    if (!body || typeof body.username !== "string") return errorResponse("'username' is required")
    const role = body.role ?? "member"
    if (role !== "admin" && role !== "owner" && role !== "member") return errorResponse("'role' must be 'admin', 'owner' or 'member'")
    const asked = typeof body.tenant === "string" && body.tenant ? body.tenant.trim().toLowerCase() : undefined

    let tenant: string | undefined
    if ("all" in reach) {
      if (role === "admin" && asked) return errorResponse("An admin has no tenant")
      if (asked && !this.tenants.tenants.some((t) => t.domain === asked)) return errorResponse(`No tenant '${asked}'`)
      tenant = asked
    } else {
      if (role !== "member") return errorResponse("Only an admin can add an owner or an admin", 403)
      if (asked && asked !== reach.tenant) return errorResponse(`You can only add users to ${reach.tenant}`, 403)
      tenant = reach.tenant
    }

    const chosen = this.chosenPassword(body)
    if (chosen instanceof Response) return chosen
    const password = chosen ?? generatePassword()
    try {
      const user = await this.users.create({ username: body.username, role, tenant, password })
      return jsonResponse({ user: this.users.toInfo(user), ...(chosen === undefined && { password }), generated: chosen === undefined })
    } catch (err) {
      if (err instanceof ValidationError) return errorResponse(err.message, 400)
      throw err
    }
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
    const body = await readJson(req)
    if (typeof body?.new !== "string") return errorResponse("'new' is required")
    if (!this.failures.tryHit(ip)) return errorResponse("Too many failed attempts, try again in a minute", 429)
    if (!(await this.users.verifyPassword(auth.user.username, body.current))) return errorResponse("Current password is wrong", 403)
    this.failures.undo(ip)
    try {
      await this.users.setPassword(auth.user.username, body.new, auth.key.kind === "session" ? auth.key.id : undefined)
    } catch (err) {
      if (err instanceof ValidationError) return errorResponse(err.message, 400)
      throw err
    }
    return jsonResponse({ changed: true })
  }
}
