/**
 * Cloudflare API utilities for DNS management
 */

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4"
const IPIFY_API = "https://api.ipify.org"

export interface CloudflareZone {
  id: string
  name: string
}

export interface CloudflareDNSRecord {
  id: string
  name: string
  type: string
  content: string
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
  const response = await fetch(`${CLOUDFLARE_API}/zones`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  })

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new CloudflareError("Invalid or expired Cloudflare API token")
    }
    throw new CloudflareError(`Cloudflare API error: ${response.statusText}`)
  }

  const data = await response.json() as { success: boolean; errors?: { message: string }[]; result?: CloudflareZone[] }
  if (!data.success) {
    const errorMsg = data.errors?.[0]?.message || "Unknown error"
    throw new CloudflareError(`Cloudflare API error: ${errorMsg}`)
  }

  return data.result || []
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
  const response = await fetch(`${CLOUDFLARE_API}/zones/${zoneId}/dns_records?${params}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  })

  if (!response.ok) {
    throw new CloudflareError(`Cloudflare API error: ${response.statusText}`)
  }

  const data = await response.json() as { success: boolean; result?: CloudflareDNSRecord[] }
  if (!data.success || !data.result?.length) {
    return null
  }

  return data.result[0] ?? null
}

/**
 * Create an A record
 */
export async function createARecord(
  token: string,
  zoneId: string,
  name: string,
  ip: string
): Promise<void> {
  const response = await fetch(`${CLOUDFLARE_API}/zones/${zoneId}/dns_records`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "A",
      name,
      content: ip,
      ttl: 1, // Auto TTL
      proxied: false, // Direct connection for wildcard certs
    }),
  })

  if (!response.ok) {
    const data = await response.json() as { errors?: { message: string }[] }
    const errorMsg = data.errors?.[0]?.message || response.statusText
    throw new CloudflareError(`Failed to create DNS record: ${errorMsg}`)
  }
}

/**
 * Setup wildcard DNS record for a domain
 * Returns a result object with status and message
 */
export async function setupWildcardDNS(
  token: string,
  domain: string
): Promise<{ success: boolean; message: string; skipped?: boolean }> {
  // Get public IP
  const publicIP = await getPublicIP()

  // List zones
  const zones = await listZones(token)
  if (zones.length === 0) {
    throw new CloudflareError("No Cloudflare zones accessible with this token")
  }

  // Find matching zone
  const zone = findMatchingZone(domain, zones)
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
    return {
      success: true,
      skipped: true,
      message: `DNS record ${wildcardName} already exists (pointing to ${existingRecord.content}), skipping`,
    }
  }

  // Create the wildcard record
  await createARecord(token, zone.id, wildcardName, publicIP)

  return {
    success: true,
    message: `Created DNS record ${wildcardName} → ${publicIP}`,
  }
}
