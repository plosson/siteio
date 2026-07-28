import { isIP } from "node:net"
import { lookup } from "node:dns/promises"
import { ValidationError } from "./errors.ts"

// SSRF guard for URLs the AGENT fetches on a caller's behalf (write_url). The
// agent sits next to internal services (Traefik's API, other containers, the
// cloud metadata endpoint), so a fetch to an internal address whose response is
// then written into a public site is an exfiltration vector. We reject any URL
// that resolves to a private/reserved address, allow only http(s), and (at the
// fetch site) refuse redirects so a public URL can't bounce to an internal one.

function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map((n) => Number(n))
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true
  const [a, b] = p as [number, number, number, number]
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // private
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 192 && b === 0) return true // 192.0.0.0/24 (protocol assignments)
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
  if (a >= 224) return true // multicast / reserved / broadcast
  return false
}

function isPrivateV6(ip: string): boolean {
  const s = ip.toLowerCase()
  if (s === "::1" || s === "::") return true // loopback / unspecified
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) // IPv4-mapped
  if (mapped) return isPrivateV4(mapped[1]!)
  if (/^fe[89ab]/.test(s)) return true // fe80::/10 link-local
  if (/^f[cd]/.test(s)) return true // fc00::/7 unique-local
  return false
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) return isPrivateV4(ip)
  if (v === 6) return isPrivateV6(ip)
  return true // not a recognizable IP — treat as unsafe
}

// Throw a ValidationError unless `raw` is an http(s) URL whose host resolves
// only to public addresses. Returns the parsed URL on success.
export async function assertSafePublicUrl(raw: string): Promise<URL> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new ValidationError("Invalid URL")
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ValidationError("Only http(s) URLs can be fetched")
  }
  const host = u.hostname.replace(/^\[|\]$/g, "") // strip IPv6 brackets

  let addresses: string[]
  if (isIP(host)) {
    addresses = [host]
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((r) => r.address)
    } catch {
      throw new ValidationError(`Could not resolve host: ${host}`)
    }
  }
  if (addresses.length === 0) throw new ValidationError(`Could not resolve host: ${host}`)
  for (const addr of addresses) {
    if (isPrivateAddress(addr)) {
      throw new ValidationError("Refusing to fetch an internal/private address")
    }
  }
  return u
}
