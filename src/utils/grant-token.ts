import { randomBytes, createHash } from "crypto"

// Share-grant tokens are opaque bearer secrets embedded in an MCP link. They
// carry no data — the agent looks them up by hash in the GrantStore. Format:
// `grt_` + 32 random bytes, base64url (no padding). Only the sha-256 of the
// token is persisted; the raw value is shown to the owner exactly once.

const TOKEN_PREFIX = "grt_"
const TOKEN_BYTES = 32

function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(TOKEN_BYTES).toString("base64url")}`
}

export function generateGrantToken(): string {
  return randomToken(TOKEN_PREFIX)
}

// User keys (a CLI login or an admin UI session): `usr_` + 32 random bytes,
// stored as their sha-256 like grant tokens. See UserStore.
export function generateUserKey(): string {
  return randomToken("usr_")
}

export function hashGrantToken(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex")
}

// Cheap shape check used to reject junk before any store lookup (guardrail:
// validate the token is well-formed before doing MCP handshake work).
export function isWellFormedGrantToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX) && /^grt_[A-Za-z0-9_-]{20,}$/.test(token)
}

// Short public id for a grant, safe to print and pass to `share revoke`.
export function generateGrantId(): string {
  const raw = randomBytes(4).toString("hex")
  return `grt_${raw}`
}
