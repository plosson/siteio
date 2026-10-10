// The visitor's IP for an access-log entry. Behind Cloudflare's proxy Traefik
// sees a Cloudflare edge IP; the visitor's is in CF-Connecting-IP. Anyone can
// send that header straight to the origin, so it is trusted only when the
// connection itself comes from Cloudflare. No dependencies: IPs as bigints.
import type { AccessLogEntry } from "./classify.ts"

// https://www.cloudflare.com/ips/ (checked 2026-10-10). Re-check on release.
const CLOUDFLARE_RANGES = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
  "2a06:98c0::/29", "2c0f:f248::/32",
]

export interface ParsedIp {
  version: 4 | 6
  value: bigint
}

function parseV4(ip: string): bigint | null {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let n = 0n
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null
    n = (n << 8n) | BigInt(p)
  }
  return n
}

function parseV6(ip: string): bigint | null {
  if (!/^[0-9a-fA-F:.]+$/.test(ip)) return null
  let s = ip
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two hex groups.
  if (s.includes(".")) {
    const cut = s.lastIndexOf(":")
    const v4 = parseV4(s.slice(cut + 1))
    if (v4 === null) return null
    s = `${s.slice(0, cut + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`
  }
  const halves = s.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail]
  let n = 0n
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    n = (n << 16n) | BigInt(parseInt(g, 16))
  }
  return n
}

export function parseIp(ip: string): ParsedIp | null {
  const v4 = parseV4(ip)
  if (v4 !== null) return { version: 4, value: v4 }
  const v6 = ip.includes(":") ? parseV6(ip) : null
  if (v6 === null) return null
  // IPv4-mapped (::ffff:a.b.c.d): compare against the IPv4 ranges.
  if (v6 >> 32n === 0xffffn) return { version: 4, value: v6 & 0xffffffffn }
  return { version: 6, value: v6 }
}

const RANGES = CLOUDFLARE_RANGES.map((cidr) => {
  const [base, bits] = cidr.split("/") as [string, string]
  const parsed = parseIp(base)!
  const shift = BigInt((parsed.version === 4 ? 32 : 128) - Number(bits))
  return { version: parsed.version, shift, prefix: parsed.value >> shift }
})

export function isCloudflareIp(ip: string): boolean {
  const parsed = parseIp(ip)
  if (!parsed) return false
  return RANGES.some((r) => r.version === parsed.version && parsed.value >> r.shift === r.prefix)
}

export function clientIp(e: AccessLogEntry): string {
  const forwarded = e["request_Cf-Connecting-Ip"]?.trim()
  if (forwarded && parseIp(forwarded) && isCloudflareIp(e.ClientHost)) return forwarded
  return e.ClientHost
}
