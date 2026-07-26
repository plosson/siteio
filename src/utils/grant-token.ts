import { randomBytes, createHash } from "crypto"

// Share-grant tokens are opaque bearer secrets embedded in an MCP link. They
// carry no data — the agent looks them up by hash in the GrantStore. Format:
// `grt_` + 32 random bytes, base64url (no padding). Only the sha-256 of the
// token is persisted; the raw value is shown to the owner exactly once.

const TOKEN_PREFIX = "grt_"
const TOKEN_BYTES = 32

export function generateGrantToken(): string {
  const raw = randomBytes(TOKEN_BYTES)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  return `${TOKEN_PREFIX}${raw}`
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
