import { isCloudflareIp, parseIp } from "./analytics/client-ip.ts"

// 10/8, 172.16/12, 192.168/16, 127/8
const PRIVATE_V4: [bigint, number][] = [[0x0a000000n, 8], [0xac100000n, 12], [0xc0a80000n, 16], [0x7f000000n, 8]]

function isPrivate(ip: string): boolean {
  const p = parseIp(ip)
  if (!p) return false
  if (p.version === 4) return PRIVATE_V4.some(([base, bits]) => p.value >> BigInt(32 - bits) === base >> BigInt(32 - bits))
  return p.value === 1n || p.value >> 121n === 0x7en // ::1, fc00::/7
}

// The client's IP, for rate limits. Traefik reaches the agent from the Docker
// bridge, so a private or loopback peer is Traefik (or the box itself): the
// last X-Forwarded-For entry is then the address that connected to Traefik,
// which Traefik appends itself. Behind Cloudflare that address is an edge, and
// CF-Connecting-IP names the visitor. A public peer reached the agent
// directly, and its headers are not trusted.
export function requestIp(req: Request, peer: string): string {
  if (!isPrivate(peer)) return peer
  const forwarded = req.headers.get("x-forwarded-for")?.split(",").pop()?.trim()
  if (!forwarded || !parseIp(forwarded)) return peer
  const visitor = req.headers.get("cf-connecting-ip")?.trim()
  if (visitor && parseIp(visitor) && isCloudflareIp(forwarded)) return visitor
  return forwarded
}
