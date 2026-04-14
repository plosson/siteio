export interface OIDCDiscoveryResult {
  issuer: string
  endSessionEndpoint?: string
}

export async function discoverOIDC(issuerUrl: string): Promise<OIDCDiscoveryResult> {
  const base = issuerUrl.replace(/\/$/, "")
  const url = `${base}/.well-known/openid-configuration`

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`OIDC discovery failed: ${response.status} ${response.statusText} (${url})`)
  }

  const doc = (await response.json()) as { issuer?: string; end_session_endpoint?: string }

  if (!doc.issuer) {
    throw new Error(`OIDC discovery document missing issuer field (${url})`)
  }

  return {
    issuer: doc.issuer,
    endSessionEndpoint: doc.end_session_endpoint,
  }
}
