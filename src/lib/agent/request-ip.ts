import { inRanges, isCloudflareIp, parseIp, parseRanges } from "./analytics/client-ip.ts"

const PRIVATE = parseRanges(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "::1/128", "fc00::/7"])

const isPrivate = (ip: string) => inRanges(ip, PRIVATE)

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
