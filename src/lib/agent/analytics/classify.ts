// Pure classification of Traefik JSON access-log lines (see traefik.ts
// generateStaticConfig for the fields we keep). No I/O.

// The subset of a Traefik access-log line we read. Header fields are present
// only because the static config keeps those headers.
export interface AccessLogEntry {
  StartUTC: string
  RouterName?: string
  RequestMethod: string
  RequestHost: string
  RequestPath: string
  DownstreamStatus: number
  DownstreamContentSize: number
  Duration: number // nanoseconds
  ClientHost: string
  "request_User-Agent"?: string
  "request_Referer"?: string
  "downstream_Content-Type"?: string
  // Go canonicalizes header names, so CF-Connecting-IP is logged as Cf-Connecting-Ip.
  "request_Cf-Connecting-Ip"?: string
}

export type StatusClass = "2xx" | "3xx" | "4xx" | "5xx"

const STRING_FIELDS = ["StartUTC", "RequestMethod", "RequestHost", "RequestPath", "ClientHost"] as const
const NUMBER_FIELDS = ["DownstreamStatus", "DownstreamContentSize", "Duration"] as const

export function parseEntry(line: string): AccessLogEntry | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (STRING_FIELDS.some((f) => typeof obj[f] !== "string")) return null
  if (NUMBER_FIELDS.some((f) => typeof obj[f] !== "number")) return null
  return obj as unknown as AccessLogEntry
}

// Site and app containers are `siteio-<key>`, and so is their router; a site
// with custom domains also has `siteio-<key>-canonical` (server.ts
// buildSiteRoutingLabels). Returns the storage keys to try, most exact first.
// The agent's own routers (`api-router`, `mcp-router`) give none.
const ROUTER_PREFIX = "siteio-"
const CANONICAL_SUFFIX = "-canonical"

export function routerKeys(routerName: string | undefined): string[] {
  if (!routerName) return []
  const bare = routerName.split("@")[0]!
  if (!bare.startsWith(ROUTER_PREFIX)) return []
  const key = bare.slice(ROUTER_PREFIX.length)
  if (!key) return []
  if (key.endsWith(CANONICAL_SUFFIX) && key.length > CANONICAL_SUFFIX.length) {
    return [key, key.slice(0, -CANONICAL_SUFFIX.length)]
  }
  return [key]
}

// Crawlers, link unfurlers, monitors, HTTP libraries, and headless browsers
// (including our own thumbnail renderer). An empty user agent is a script.
const BOT_RE =
  /bot|crawl|spider|slurp|headless|curl|wget|python|go-http-client|java\/|okhttp|axios|node-fetch|libwww|httpclient|facebookexternalhit|preview|monitor|uptime|pingdom|lighthouse/i

export function isBot(userAgent: string | undefined): boolean {
  if (!userAgent || !userAgent.trim()) return true
  return BOT_RE.test(userAgent)
}

// Agent-owned paths and backend API paths are never pages.
const NON_PAGE_PREFIXES = ["/_siteio", "/mcp", "/api", "/.well-known"]

function hasPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

export function isPageview(e: AccessLogEntry): boolean {
  if (e.RequestMethod !== "GET") return false
  if (statusClass(e.DownstreamStatus) !== "2xx") return false
  if (!(e["downstream_Content-Type"] ?? "").toLowerCase().startsWith("text/html")) return false
  if (isBot(e["request_User-Agent"])) return false
  const path = cleanPath(e.RequestPath)
  return !NON_PAGE_PREFIXES.some((p) => hasPrefix(path, p))
}

// Query strings can carry secrets (edit codes, OAuth codes, app tokens): keep
// only campaign tags. Parsed by hand so a bad percent-encoding cannot throw.
const KEPT_PARAMS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"])

export function cleanPath(requestPath: string): string {
  const noFragment = requestPath.split("#")[0]!
  const q = noFragment.indexOf("?")
  if (q === -1) return noFragment
  const path = noFragment.slice(0, q)
  const kept = noFragment
    .slice(q + 1)
    .split("&")
    .filter((pair) => KEPT_PARAMS.has(pair.split("=")[0]!))
  return kept.length ? `${path}?${kept.join("&")}` : path
}

export function statusClass(status: number): StatusClass | null {
  if (!Number.isInteger(status) || status < 200 || status > 599) return null
  return `${Math.floor(status / 100)}xx` as StatusClass
}
