import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { generateAccessToken, generateAuthCode, generateClientId } from "../../utils/oauth.ts"

// Authorization codes are exchanged for a token within seconds; keep them short.
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// A dynamically-registered OAuth client (one per connector setup in claude.ai).
export interface OAuthClient {
  clientId: string
  redirectUris: string[]
  clientName?: string
  createdAt: string
}

// A one-time authorization code, bound to the grant, client, redirect, and PKCE
// challenge it was issued for.
export interface AuthCodeRecord {
  code: string
  grantId: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  expiresAt: string
}

// A bearer access token that leases access to a grant. The grant is re-checked
// on every MCP call, so the token dies the moment the grant is revoked/expired/
// exhausted regardless of this record's own expiry.
export interface AccessTokenRecord {
  token: string
  grantId: string
  expiresAt: string
  createdAt: string
}

// Persists the OAuth authorization-server state as JSON files under
// `<dataDir>/oauth/{clients,authcodes,tokens}`. Mirrors GrantStore's shape.
export class OAuthStore {
  private clientsDir: string
  private codesDir: string
  private tokensDir: string

  constructor(dataDir: string) {
    const root = join(dataDir, "oauth")
    this.clientsDir = join(root, "clients")
    this.codesDir = join(root, "authcodes")
    this.tokensDir = join(root, "tokens")
    for (const d of [this.clientsDir, this.codesDir, this.tokensDir]) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 })
    }
  }

  private read<T>(path: string): T | null {
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as T
    } catch {
      return null
    }
  }

  // --- Clients (Dynamic Client Registration, RFC 7591) ---

  registerClient(input: { redirectUris: string[]; clientName?: string }): OAuthClient {
    const client: OAuthClient = {
      clientId: generateClientId(),
      redirectUris: input.redirectUris,
      clientName: input.clientName,
      createdAt: new Date().toISOString(),
    }
    writeFileSync(join(this.clientsDir, `${client.clientId}.json`), JSON.stringify(client, null, 2), { mode: 0o600 })
    return client
  }

  getClient(clientId: string): OAuthClient | null {
    if (!/^cid_[A-Za-z0-9_-]+$/.test(clientId)) return null
    return this.read<OAuthClient>(join(this.clientsDir, `${clientId}.json`))
  }

  // --- Authorization codes ---

  createAuthCode(input: {
    grantId: string
    clientId: string
    redirectUri: string
    codeChallenge: string
  }): string {
    const code = generateAuthCode()
    const record: AuthCodeRecord = {
      code,
      grantId: input.grantId,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString(),
    }
    writeFileSync(join(this.codesDir, `${code}.json`), JSON.stringify(record), { mode: 0o600 })
    return code
  }

  // Single-use: the record is deleted on read. Returns null if missing/expired.
  consumeAuthCode(code: string): AuthCodeRecord | null {
    if (!/^ac_[A-Za-z0-9_-]+$/.test(code)) return null
    const path = join(this.codesDir, `${code}.json`)
    const record = this.read<AuthCodeRecord>(path)
    if (record) rmSync(path, { force: true })
    if (!record) return null
    if (Date.now() >= Date.parse(record.expiresAt)) return null
    return record
  }

  // --- Access tokens ---

  createAccessToken(input: { grantId: string; expiresAt: string }): string {
    const token = generateAccessToken()
    const record: AccessTokenRecord = {
      token,
      grantId: input.grantId,
      expiresAt: input.expiresAt,
      createdAt: new Date().toISOString(),
    }
    writeFileSync(join(this.tokensDir, `${token}.json`), JSON.stringify(record), { mode: 0o600 })
    return token
  }

  resolveAccessToken(token: string): AccessTokenRecord | null {
    if (!/^at_[A-Za-z0-9_-]+$/.test(token)) return null
    const record = this.read<AccessTokenRecord>(join(this.tokensDir, `${token}.json`))
    if (!record) return null
    if (Date.now() >= Date.parse(record.expiresAt)) return null
    return record
  }

  // Drop every access token tied to a grant (used when a grant is revoked so
  // outstanding connectors stop working immediately).
  revokeTokensForGrant(grantId: string): void {
    for (const f of readdirSync(this.tokensDir).filter((f) => f.endsWith(".json"))) {
      const rec = this.read<AccessTokenRecord>(join(this.tokensDir, f))
      if (rec?.grantId === grantId) rmSync(join(this.tokensDir, f), { force: true })
    }
  }

  // Reclaim expired auth codes and access tokens.
  gc(): void {
    const now = Date.now()
    for (const dir of [this.codesDir, this.tokensDir]) {
      for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        const rec = this.read<{ expiresAt: string }>(join(dir, f))
        if (!rec || now >= Date.parse(rec.expiresAt)) rmSync(join(dir, f), { force: true })
      }
    }
  }
}
