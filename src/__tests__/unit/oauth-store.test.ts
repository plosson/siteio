import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { createHash, randomBytes } from "crypto"
import { OAuthStore, AUTH_CODE_TTL_MS } from "../../lib/agent/oauth-store.ts"
import { verifyPkceS256 } from "../../utils/oauth.ts"

// Build a valid PKCE pair the way a client would.
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

describe("Unit: OAuth PKCE", () => {
  test("verifyPkceS256 accepts a matching verifier/challenge", () => {
    const { verifier, challenge } = pkce()
    expect(verifyPkceS256(verifier, challenge)).toBe(true)
  })
  test("verifyPkceS256 rejects a mismatch or empty input", () => {
    const { challenge } = pkce()
    expect(verifyPkceS256("wrong-verifier", challenge)).toBe(false)
    expect(verifyPkceS256("", challenge)).toBe(false)
    expect(verifyPkceS256("x", "")).toBe(false)
  })
})

describe("Unit: OAuthStore", () => {
  let dataDir: string
  let store: OAuthStore

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-oauth-"))
    store = new OAuthStore(dataDir)
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  test("registerClient issues a client_id and round-trips", () => {
    const client = store.registerClient({ redirectUris: ["https://claude.ai/cb"], clientName: "Claude" })
    expect(client.clientId).toStartWith("cid_")
    expect(store.getClient(client.clientId)?.redirectUris).toEqual(["https://claude.ai/cb"])
  })

  test("getClient rejects malformed ids without touching disk", () => {
    expect(store.getClient("../etc/passwd")).toBeNull()
    expect(store.getClient("nope")).toBeNull()
  })

  test("auth code is single-use and carries its binding", () => {
    const code = store.createAuthCode({
      grantId: "grt_x", clientId: "cid_y", redirectUri: "https://claude.ai/cb", codeChallenge: "abc",
    })
    expect(code).toStartWith("ac_")
    const rec = store.consumeAuthCode(code)
    expect(rec?.grantId).toBe("grt_x")
    expect(rec?.codeChallenge).toBe("abc")
    // Second consumption fails (single-use).
    expect(store.consumeAuthCode(code)).toBeNull()
  })

  test("expired auth codes are not returned", () => {
    const code = store.createAuthCode({ grantId: "g", clientId: "c", redirectUri: "r", codeChallenge: "x" })
    // Rewrite expiry into the past.
    const path = join(dataDir, "oauth", "authcodes", `${code}.json`)
    const rec = JSON.parse(readFileSync(path, "utf-8"))
    writeFileSync(path, JSON.stringify({ ...rec, expiresAt: new Date(Date.now() - 1000).toISOString() }))
    expect(store.consumeAuthCode(code)).toBeNull()
  })

  test("access token resolves to its grant and honors expiry", () => {
    const token = store.createAccessToken({ grantId: "grt_z", expiresAt: new Date(Date.now() + 60_000).toISOString() })
    expect(token).toStartWith("at_")
    expect(store.resolveAccessToken(token)?.grantId).toBe("grt_z")

    const expired = store.createAccessToken({ grantId: "grt_z", expiresAt: new Date(Date.now() - 1000).toISOString() })
    expect(store.resolveAccessToken(expired)).toBeNull()
  })

  test("revokeTokensForGrant drops every token of a grant", () => {
    const a = store.createAccessToken({ grantId: "grt_a", expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const b = store.createAccessToken({ grantId: "grt_a", expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const other = store.createAccessToken({ grantId: "grt_b", expiresAt: new Date(Date.now() + 60_000).toISOString() })
    store.revokeTokensForGrant("grt_a")
    expect(store.resolveAccessToken(a)).toBeNull()
    expect(store.resolveAccessToken(b)).toBeNull()
    expect(store.resolveAccessToken(other)?.grantId).toBe("grt_b")
  })

  test("resolveAccessToken / consumeAuthCode reject malformed input", () => {
    expect(store.resolveAccessToken("../../evil")).toBeNull()
    expect(store.consumeAuthCode("../../evil")).toBeNull()
  })

  test("gc reclaims expired codes and tokens, keeps live ones", () => {
    const liveTok = store.createAccessToken({ grantId: "g", expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const deadTok = store.createAccessToken({ grantId: "g", expiresAt: new Date(Date.now() - 1000).toISOString() })
    store.gc()
    expect(store.resolveAccessToken(liveTok)).not.toBeNull()
    expect(store.resolveAccessToken(deadTok)).toBeNull()
    expect(AUTH_CODE_TTL_MS).toBeGreaterThan(0)
  })
})
