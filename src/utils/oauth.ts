import { randomBytes, createHash, timingSafeEqual } from "crypto"

// Helpers for the agent's minimal OAuth 2.0 authorization server (the flow that
// lets a share link work as a claude.ai / Claude Desktop custom connector).
// The "user authentication" step is possession of a share code (the grant
// token); everything else is a standard OAuth authorization-code + PKCE dance.

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function randomId(prefix: string, bytes: number): string {
  return `${prefix}${base64url(randomBytes(bytes))}`
}

export function generateClientId(): string {
  return randomId("cid_", 16)
}
export function generateAuthCode(): string {
  return randomId("ac_", 32)
}
export function generateAccessToken(): string {
  return randomId("at_", 32)
}

// Constant-time compare for opaque secrets (client_secret etc. if ever used).
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

// Verify a PKCE code_verifier against a stored S256 code_challenge (RFC 7636).
// We only support S256 — `plain` is refused.
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || !codeChallenge) return false
  const computed = base64url(createHash("sha256").update(codeVerifier).digest())
  return safeEqual(computed, codeChallenge)
}
