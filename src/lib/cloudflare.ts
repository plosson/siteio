/**
 * Cloudflare API utilities for DNS management
 */

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4"
const IPIFY_API = "https://api.ipify.org"

export interface CloudflareZone {
  id: string
  name: string
  account?: { id: string; name: string }
}

export interface CloudflareDNSRecord {
  id: string
  name: string
  type: string
  content: string
  comment?: string
  proxied?: boolean
}

export class CloudflareError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CloudflareError"
  }
}

/**
 * Fetch public IP from ipify
 */
export async function getPublicIP(): Promise<string> {
  const response = await fetch(IPIFY_API)
  if (!response.ok) {
    throw new CloudflareError(`Failed to fetch public IP: ${response.statusText}`)
  }
  const ip = await response.text()
  return ip.trim()
}

/**
 * List zones accessible by the token
 */
export async function listZones(token: string): Promise<CloudflareZone[]> {
  return cloudflareList<CloudflareZone>(token, "/zones")
}

/**
 * Find the zone that matches the domain
 * e.g., for domain "myserver.example.com", find zone "example.com"
 */
export function findMatchingZone(domain: string, zones: CloudflareZone[]): CloudflareZone | null {
  // Sort zones by name length descending to match most specific zone first
  const sortedZones = [...zones].sort((a, b) => b.name.length - a.name.length)

  for (const zone of sortedZones) {
    if (domain === zone.name || domain.endsWith(`.${zone.name}`)) {
      return zone
    }
  }

  return null
}

/**
 * Get a DNS record by name
 */
export async function getRecord(
  token: string,
  zoneId: string,
  name: string,
  type: string = "A"
): Promise<CloudflareDNSRecord | null> {
  const params = new URLSearchParams({ name, type })
  const records = await cloudflareList<CloudflareDNSRecord>(token, `/zones/${zoneId}/dns_records?${params}`)
  if (records.length > 1) throw new CloudflareError(`Multiple ${type} records exist for ${name}; resolve them before provisioning`)
  return records[0] ?? null
}

/**
 * Create an A record
 */
export async function createARecord(
  token: string,
  zoneId: string,
  name: string,
  ip: string,
  comment?: string
): Promise<CloudflareDNSRecord> {
  return cloudflareRequest<CloudflareDNSRecord>(token, `/zones/${zoneId}/dns_records`, "POST", {
    type: "A", name, content: ip, ttl: 1, proxied: false, ...(comment ? { comment } : {}),
  })
}

/**
 * Delete a DNS record by ID
 */
export async function deleteRecord(
  token: string,
  zoneId: string,
  recordId: string
): Promise<void> {
  try {
    await cloudflareRequest(token, `/zones/${zoneId}/dns_records/${recordId}`, "DELETE")
  } catch (error) {
    if (!(error instanceof CloudflareAPIError && error.status === 404)) throw error
  }
}

/**
 * Setup wildcard DNS record for a domain
 * Returns a result object with status and message
 */
export async function setupWildcardDNS(
  token: string,
  domain: string,
  options: { ip?: string; owner?: string; zoneId?: string } = {}
): Promise<{ success: boolean; message: string; skipped?: boolean; zoneId?: string; recordId?: string; owned?: boolean }> {
  // Get public IP
  const publicIP = options.ip || await getPublicIP()

  // List zones
  const zones = await listZones(token)
  if (zones.length === 0) {
    throw new CloudflareError("No Cloudflare zones accessible with this token")
  }

  // Find matching zone
  const zone = options.zoneId ? zones.find(z => z.id === options.zoneId && (domain === z.name || domain.endsWith(`.${z.name}`))) : findMatchingZone(domain, zones)
  if (!zone) {
    const availableZones = zones.map((z) => z.name).join(", ")
    throw new CloudflareError(
      `No zone found for domain "${domain}". Available zones: ${availableZones}`
    )
  }

  // Check if wildcard record already exists
  const wildcardName = `*.${domain}`
  const existingRecord = await getRecord(token, zone.id, wildcardName)

  if (existingRecord) {
    if (options.ip && (existingRecord.content !== publicIP || existingRecord.proxied)) {
      throw new CloudflareError(`DNS record ${wildcardName} already exists with different settings; refusing to overwrite it`)
    }
    return {
      zoneId: zone.id, recordId: existingRecord.id,
      owned: Boolean(options.owner && existingRecord.comment === options.owner),
      success: true,
      skipped: true,
      message: `DNS record ${wildcardName} already exists (pointing to ${existingRecord.content}), skipping`,
    }
  }

  // Create the wildcard record
  const record = await createARecord(token, zone.id, wildcardName, publicIP, options.owner)

  return {
    success: true,
    message: `Created DNS record ${wildcardName} → ${publicIP}`,
    zoneId: zone.id, recordId: record.id, owned: true,
  }
}

/**
 * Remove wildcard DNS record for a domain
 * Returns a result object with status and message
 */
export async function removeWildcardDNS(
  token: string,
  domain: string
): Promise<{ success: boolean; message: string; skipped?: boolean }> {
  // List zones
  const zones = await listZones(token)
  if (zones.length === 0) {
    throw new CloudflareError("No Cloudflare zones accessible with this token")
  }

  // Find matching zone
  const zone = findMatchingZone(domain, zones)
  if (!zone) {
    return {
      success: true,
      skipped: true,
      message: `No zone found for domain "${domain}", skipping DNS cleanup`,
    }
  }

  // Check if wildcard record exists
  const wildcardName = `*.${domain}`
  const existingRecord = await getRecord(token, zone.id, wildcardName)

  if (!existingRecord) {
    return {
      success: true,
      skipped: true,
      message: `DNS record ${wildcardName} does not exist, skipping`,
    }
  }

  // Delete the wildcard record
  await deleteRecord(token, zone.id, existingRecord.id)

  return {
    success: true,
    message: `Deleted DNS record ${wildcardName}`,
  }
}

/**
 * Build a sslip.io domain from an IP address
 * e.g., "203.0.113.42" -> "203-0-113-42.sslip.io"
 */
export function buildSslipDomain(ip: string): string {
  return `${ip.replace(/\./g, "-")}.sslip.io`
}

/**
 * Check if a domain is a sslip.io domain
 */
export function isSslipDomain(domain: string): boolean {
  return domain.endsWith(".sslip.io")
}

/**
 * Build a Cloudflare dashboard URL with pre-filled token permissions
 * Pre-selects Zone:Read, DNS:Edit, account discovery and Registrar permissions
 */
export function buildCloudflareTokenUrl(tokenName: string = "siteio DNS Token"): string {
  const permissions = JSON.stringify([
    { key: "zone", type: "read" },
    { key: "dns", type: "edit" },
    { key: "account_settings", type: "read" },
    { key: "registrar", type: "edit" },
  ])
  const params = new URLSearchParams({
    permissionGroupKeys: permissions,
    accountId: "*",
    zoneId: "all",
    name: tokenName,
  })
  return `https://dash.cloudflare.com/profile/api-tokens?${params}`
}


export class CloudflareAPIError extends CloudflareError {
  constructor(message: string, public status: number) { super(message) }
}

interface CloudflareResponse<T> {
  success: boolean
  result: T
  errors?: { message: string }[]
  result_info?: { total_pages: number }
}

async function cloudflareResponse<T>(token: string, path: string, method = "GET", body?: unknown): Promise<CloudflareResponse<T>> {
  const response = await fetch(`${CLOUDFLARE_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const data = await response.json() as CloudflareResponse<T>
  if (!response.ok || !data.success) {
    throw new CloudflareAPIError(`Cloudflare: ${data.errors?.map(e => e.message).join("; ") || response.statusText}`, response.status)
  }
  return data
}

export async function cloudflareRequest<T>(token: string, path: string, method = "GET", body?: unknown): Promise<T> {
  return (await cloudflareResponse<T>(token, path, method, body)).result
}

async function cloudflareList<T>(token: string, path: string): Promise<T[]> {
  const results: T[] = []
  for (let page = 1; ; page++) {
    const data = await cloudflareResponse<T[]>(token, `${path}${path.includes("?") ? "&" : "?"}per_page=50&page=${page}`)
    results.push(...data.result)
    if (page >= (data.result_info?.total_pages ?? 1)) return results
  }
}

export async function listCloudflareAccounts(token: string): Promise<{ id: string; name: string }[]> {
  return cloudflareList(token, "/accounts")
}

export interface DomainAvailability {
  name: string
  registrable: boolean
  reason?: string
  tier?: string
  pricing?: { currency: string; registration_cost: string; renewal_cost: string }
}
export interface RegistrationStatus {
  state: string
  completed: boolean
  error?: { code: string; message: string }
}

export async function checkDomain(token: string, account: string, domain: string): Promise<DomainAvailability> {
  const result = await cloudflareRequest<{ domains: DomainAvailability[] }>(token,
    `/accounts/${encodeURIComponent(account)}/registrar/domain-check`, "POST", { domains: [domain] })
  const match = result.domains.find(d => d.name === domain)
  if (!match) throw new CloudflareError("Cloudflare returned no availability result for this domain")
  return match
}

export async function registerDomain(token: string, account: string, domain: string): Promise<RegistrationStatus> {
  return cloudflareRequest(token, `/accounts/${encodeURIComponent(account)}/registrar/registrations`, "POST", { domain_name: domain })
}

export async function getRegistrationStatus(token: string, account: string, domain: string): Promise<RegistrationStatus> {
  return cloudflareRequest(token, `/accounts/${encodeURIComponent(account)}/registrar/registrations/${encodeURIComponent(domain)}/registration-status`)
}
