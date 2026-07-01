export interface OIDCDiscoveryResult {
  issuer: string
  endSessionEndpoint?: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
  userInfoEndpoint?: string
}

export async function discoverOIDC(issuerUrl: string): Promise<OIDCDiscoveryResult> {
  const base = issuerUrl.replace(/\/$/, "")
  const url = `${base}/.well-known/openid-configuration`

  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`OIDC discovery timed out after 10s (${url})`)
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`OIDC discovery timed out after 10s (${url})`)
    }
    throw err
  }

  if (!response.ok) {
    throw new Error(`OIDC discovery failed: ${response.status} ${response.statusText} (${url})`)
  }

  let doc: {
    issuer?: unknown
    end_session_endpoint?: unknown
    authorization_endpoint?: unknown
    token_endpoint?: unknown
    userinfo_endpoint?: unknown
  }
  try {
    doc = (await response.json()) as typeof doc
  } catch {
    throw new Error(`OIDC discovery returned non-JSON body (${url})`)
  }

  if (typeof doc.issuer !== "string" || doc.issuer.length === 0) {
    throw new Error(`OIDC discovery document missing issuer field (${url})`)
  }

  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined)

  return {
    issuer: doc.issuer,
    endSessionEndpoint: str(doc.end_session_endpoint),
    authorizationEndpoint: str(doc.authorization_endpoint),
    tokenEndpoint: str(doc.token_endpoint),
    userInfoEndpoint: str(doc.userinfo_endpoint),
  }
}
