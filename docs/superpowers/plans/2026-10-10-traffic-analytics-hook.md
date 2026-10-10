# Traffic Analytics Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `analyticsUrl` is set, the siteio agent pushes pageviews and per-site traffic counters, read from Traefik's access log, to that URL every minute.

**Architecture:** Traefik writes a JSON access log to a file in the agent's data dir. An `AccessLogTailer` reads new lines from a saved byte offset and rotates the file. Pure functions classify each line: which site or app it belongs to (from Traefik's `RouterName`), whether it is a pageview, and whether it comes from a bot. `buildBatch` turns a chunk of lines into one batch. `AnalyticsPump` runs this on a 60 s timer and POSTs each batch through a new `Analytics` hook, next to `Pager` and `Ranking`.

**Tech Stack:** Bun, TypeScript, `bun test`, Traefik v3.7 (`accessLog`, `format: json`). No new dependencies.

**Spec:** No separate spec file. The design was agreed in conversation on 2026-10-09/10 and is summarized in "Design decisions" below. Executors treat that section as the spec.

## Design decisions (the spec)

1. **Audience:** first the operator, across all agents. Site owners come later and are handled by the analytics site, not the agent.
2. **Owner hint:** each event carries the site's current `deployedBy` as `owner`. Apps have no `deployedBy` field (`App` in `src/types.ts`), so app events carry no `owner`.
3. **Location:** the agent sends the raw visitor IP (`ip`). The analytics site does GeoIP and visitor hashing. The agent does no hashing. Behind Cloudflare's proxy, the visitor IP is taken from the `CF-Connecting-IP` header, trusted **only** when the connection comes from a Cloudflare IP range (otherwise the header could be spoofed).
4. **Scope:** sites and apps, all tracked, no opt-in.
5. **Content:** pageview events plus per-site/app traffic counters for each batch.
6. **Source:** Traefik JSON access log in a file, tailed by the agent (approach A).
7. **Receiver:** any HTTP endpoint accepting the batch format below. The URL carries the secret, like `PAGERIO_URL`.

### Batch format (version 1)

```json
{
  "version": 1,
  "agent": "chuut.com",
  "from": "2026-10-10T12:00:00.000Z",
  "to": "2026-10-10T12:00:59.000Z",
  "pageviews": [
    {
      "ts": "2026-10-10T12:00:03.000Z",
      "kind": "site",
      "name": "blog",
      "owner": "pierre",
      "host": "blog.chuut.com",
      "path": "/posts/1?utm_source=hn",
      "referrer": "https://news.ycombinator.com/",
      "userAgent": "Mozilla/5.0 ...",
      "ip": "203.0.113.9",
      "status": 200,
      "durationMs": 12
    }
  ],
  "traffic": [
    {
      "kind": "site",
      "name": "blog",
      "owner": "pierre",
      "requests": 140,
      "bytes": 2048000,
      "status": { "2xx": 120, "3xx": 10, "4xx": 9, "5xx": 1 },
      "bots": 30,
      "p50Ms": 4,
      "p95Ms": 80
    }
  ]
}
```

- `name` is the storage key: `blog` on the primary domain, `blog--friend-com` for a tenant site. `host` tells the analytics site which hostname was hit.
- `from` / `to` are the earliest and latest request times in the batch.
- `traffic` counts **every** request routed to that site/app, bots included. `bots` is the subset from bots.
- A pageview is a `GET` with a 2xx status, a `text/html` response, a non-bot user agent, and a path outside `/_siteio`, `/mcp`, `/api` and `/.well-known`.

## Global Constraints

- Config key `analyticsUrl`, env var `ANALYTICS_URL`. The env var wins. The value must start with `http://` or `https://`. It is a sensitive key (masked in `config list`), like `pagerUrl`.
- Traefik writes the access log **only** when `analyticsUrl` is set. Traefik is recreated on every agent start, so a restart applies the change.
- Access log on the host: `<dataDir>/traefik-logs/access.log`, mounted read-write at `/logs` in the Traefik container. (`<dataDir>/traefik` is mounted read-only, so it can't hold the log.)
- Best-effort, like the other hooks. A failed or slow POST never affects serving. A failed batch is logged once and dropped, with no retry. The read offset still advances.
- Batch interval: 60 s. Chunk size: 4 MiB per read. The file rotates once the read offset passes 20 MiB.
- Missing or failed batches are acceptable (confirmed by the user 2026-10-10): no retry, no spool.
- `ip` is `CF-Connecting-IP` when the connecting IP is in Cloudflare's published ranges and the header holds a valid IP; otherwise Traefik's `ClientHost`.
- The query string is removed from `path`, except `utm_source`, `utm_medium`, `utm_campaign`, `utm_term` and `utm_content`.
- Wire types live in `src/types.ts`; the outbound POST goes through `postHook` in `src/lib/agent/hooks.ts`.
- New analytics code lives in `src/lib/agent/analytics/`.
- Tests are adversarial, not happy-path (user rule). Run with `bun test`; typecheck with `bun run typecheck`.

## Review Focus

1. **Secrets in query strings.** Edit links (`/_siteio/edit?...`), OAuth callbacks (`?code=...&state=...`) and app tokens must never leave the server. Only `utm_*` survives. Pinned in Task 2.
2. **Our own machinery counted as visitors.** The thumbnail renderer (HeadlessChrome), uptime monitors, `curl`, and requests with an empty user agent must not become pageviews. Pinned in Task 2.
3. **A half-written last line.** Traefik may be mid-write when we read. The partial line must be neither lost nor parsed as garbage; it is read on the next tick. Pinned in Task 5.
4. **Analytics endpoint down or hanging.** The agent keeps serving. A tick never overlaps the previous one. A failed batch logs one line and is dropped. Pinned in Task 7.
5. **Router names that don't map simply.** `siteio-blog-canonical@docker` (a site with custom domains), tenant keys `siteio-blog--friend-com@docker`, the agent's own `api-router@file` / `mcp-router@file`, and log lines with no router (a 404 on an unknown host) must resolve to the right site or be ignored. Pinned in Tasks 2 and 4.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `src/types.ts` | Modify | `analyticsUrl` on `AgentConfig`; wire types `AnalyticsBatch`, `AnalyticsPageview`, `AnalyticsTraffic` |
| `src/config/agent.ts` | Modify | `analyticsUrl` on `PersistedAgentConfig`; sensitive key |
| `src/commands/agent/config.ts` | Modify | `analyticsUrl` in `VALID_KEYS` and the URL check |
| `src/commands/agent/start.ts` | Modify | `hookUrl("ANALYTICS_URL", "analyticsUrl")`, banner line |
| `src/lib/agent/analytics/classify.ts` | Create | Pure: parse one log line, router → candidate keys, bot check, pageview check, path cleaning, status class |
| `src/lib/agent/analytics/client-ip.ts` | Create | Pure: IP parsing, Cloudflare ranges, real visitor IP of an entry |
| `src/lib/agent/analytics/batch.ts` | Create | Pure: entries → `AnalyticsBatch` |
| `src/lib/agent/analytics/tailer.ts` | Create | File I/O: read new complete lines from an offset, rotate |
| `src/lib/agent/analytics/pump.ts` | Create | Timer: tailer → batch → send, no overlap |
| `src/lib/agent/hooks.ts` | Modify | `Analytics` class |
| `src/lib/agent/traefik.ts` | Modify | `accessLog` option, logs mount, `accessLogPath()`, `reopenAccessLog()` |
| `src/lib/agent/server.ts` | Modify | Build the pump when `analyticsUrl` is set; resolve keys; start/stop; test hook |
| `CLAUDE.md` | Modify | Document `ANALYTICS_URL` next to `RANKING_URL` |
| Tests | Create/Modify | `src/__tests__/unit/analytics-classify.test.ts`, `analytics-client-ip.test.ts`, `analytics-batch.test.ts`, `analytics-tailer.test.ts`, `analytics-pump.test.ts`, `src/__tests__/api/analytics.test.ts`, `src/__tests__/cli/agent-config.test.ts`, `src/__tests__/unit/traefik-manager.test.ts` |

---

### Task 1: `analyticsUrl` config key

**Files:**
- Modify: `src/types.ts:230` (add the field after `rankingUrl`)
- Modify: `src/config/agent.ts:29` and `src/config/agent.ts:147`
- Modify: `src/commands/agent/config.ts:22` and `src/commands/agent/config.ts:107`
- Modify: `src/commands/agent/start.ts:145-193`
- Modify: `CLAUDE.md` (Environment Variables section)
- Test: `src/__tests__/cli/agent-config.test.ts`

**Interfaces:**
- Produces: `AgentConfig.analyticsUrl?: string`, `PersistedAgentConfig.analyticsUrl?: string`

- [ ] **Step 1: Write the failing tests**

Add inside the `describe` block that holds the `rankingUrl` tests in `src/__tests__/cli/agent-config.test.ts`:

```ts
  test.each(["analytics.example.com/api/ingest", "ftp://x.example.com", "javascript:alert(1)", ""])(
    "analyticsUrl rejects a non-http(s) value: %p",
    async (bad) => {
      const res = await runCli(["agent", "config", "set", "analyticsUrl", bad])
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toContain("analyticsUrl must start with http:// or https://")
      expect(existsSync(join(dataDir, "agent-config.json"))).toBe(false)
    }
  )

  test("analyticsUrl is masked in config list: the URL is the secret", async () => {
    const url = "https://analytics.example.com/api/ingest?key=topsecretvalue"
    expect((await runCli(["agent", "config", "set", "analyticsUrl", url])).exitCode).toBe(0)
    const list = await runCli(["--json", "agent", "config", "list"])
    expect(list.stdout).not.toContain("topsecretvalue")
    expect(JSON.parse((await runCli(["--json", "agent", "config", "get", "analyticsUrl"])).stdout).analyticsUrl).toBe(url)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/__tests__/cli/agent-config.test.ts`
Expected: FAIL with "Unknown config key" in stderr instead of the URL message.

- [ ] **Step 3: Implement**

`src/types.ts`, in `AgentConfig` after `rankingUrl`:

```ts
  analyticsUrl?: string // traffic analytics endpoint sent pageviews + traffic counters every minute (ANALYTICS_URL)
```

`src/config/agent.ts`, in `PersistedAgentConfig` after `rankingUrl`:

```ts
  analyticsUrl?: string // traffic analytics endpoint; ANALYTICS_URL wins. The URL is the secret.
```

and in `isSensitiveKey`:

```ts
  const sensitiveKeys = ["apiKey", "cloudflareToken", "acmeDnsEnv", "llmOauthToken", "llmApiKey", "pagerUrl", "analyticsUrl", "tenants"]
```

`src/commands/agent/config.ts`, in `VALID_KEYS` after `"rankingUrl",`:

```ts
  // Traffic analytics endpoint sent pageviews + traffic (masked: the URL is the secret).
  "analyticsUrl",
```

and the check:

```ts
  if ((key === "pagerUrl" || key === "rankingUrl" || key === "analyticsUrl") && !/^https?:\/\//.test(value)) {
```

`src/commands/agent/start.ts`: widen the `hookUrl` key type and add the URL:

```ts
  const hookUrl = (envVar: string, key: "pagerUrl" | "rankingUrl" | "analyticsUrl"): string | undefined => {
```

```ts
  // Sends pageviews + traffic counters, read from Traefik's access log, every minute.
  const analyticsUrl = hookUrl("ANALYTICS_URL", "analyticsUrl")
```

Add `analyticsUrl,` to the `config` object after `rankingUrl,`, and the banner line after the Ranking line:

```ts
  console.log(`  Analytics:  ${analyticsUrl ? "enabled" : "disabled (set ANALYTICS_URL or analyticsUrl)"}`)
```

`CLAUDE.md`, after the `RANKING_URL` bullet:

```markdown
- `ANALYTICS_URL` - traffic analytics endpoint, separate from `PAGERIO_URL` and `RANKING_URL`; when set, Traefik writes a JSON access log and the agent POSTs a batch of pageviews + per-site/app traffic counters every minute (format: `docs/superpowers/plans/2026-10-10-traffic-analytics-hook.md`). Best-effort: a failed batch is dropped. Can also be persisted with `siteio agent config set analyticsUrl <url>`
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/__tests__/cli/agent-config.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/config/agent.ts src/commands/agent/config.ts src/commands/agent/start.ts CLAUDE.md src/__tests__/cli/agent-config.test.ts
git commit -m "feat: analyticsUrl agent config key"
```

---

### Task 2: Wire types and line classification

**Files:**
- Modify: `src/types.ts` (append wire types)
- Create: `src/lib/agent/analytics/classify.ts`
- Test: `src/__tests__/unit/analytics-classify.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`): `AnalyticsPageview`, `AnalyticsTraffic`, `AnalyticsBatch`, `AnalyticsKind`
- Produces (in `classify.ts`):
  - `interface AccessLogEntry`: the parsed subset of one Traefik log line
  - `parseEntry(line: string): AccessLogEntry | null`
  - `routerKeys(routerName: string | undefined): string[]`
  - `isBot(userAgent: string | undefined): boolean`
  - `isPageview(entry: AccessLogEntry): boolean`
  - `cleanPath(requestPath: string): string`
  - `statusClass(status: number): StatusClass | null`, with `type StatusClass = "2xx" | "3xx" | "4xx" | "5xx"`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/unit/analytics-classify.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import {
  cleanPath,
  isBot,
  isPageview,
  parseEntry,
  routerKeys,
  statusClass,
  type AccessLogEntry,
} from "../../lib/agent/analytics/classify"

const entry = (over: Partial<AccessLogEntry> = {}): AccessLogEntry => ({
  StartUTC: "2026-10-10T12:00:03Z",
  RouterName: "siteio-blog@docker",
  RequestMethod: "GET",
  RequestHost: "blog.chuut.com",
  RequestPath: "/",
  DownstreamStatus: 200,
  DownstreamContentSize: 512,
  Duration: 12_000_000,
  ClientHost: "203.0.113.9",
  "request_User-Agent": "Mozilla/5.0 (Macintosh) Firefox/130.0",
  "downstream_Content-Type": "text/html; charset=utf-8",
  ...over,
})

describe("parseEntry", () => {
  test("parses a real Traefik JSON line", () => {
    const line = JSON.stringify({ ...entry(), level: "info", msg: "", time: "2026-10-10T12:00:03Z" })
    expect(parseEntry(line)?.RouterName).toBe("siteio-blog@docker")
  })

  test.each([
    "",
    "not json",
    '{"StartUTC":"2026-10-10T12:00:03Z"',
    "null",
    "[]",
    '"a string"',
    JSON.stringify({ ...entry(), DownstreamStatus: "200" }),
    JSON.stringify({ ...entry(), StartUTC: undefined }),
    JSON.stringify({ ...entry(), RequestPath: 42 }),
    JSON.stringify({ ...entry(), Duration: null }),
  ])("rejects a malformed or incomplete line: %p", (line) => {
    expect(parseEntry(line)).toBeNull()
  })

  test("a line with no router (404 on an unknown host) still parses", () => {
    const { RouterName: _, ...noRouter } = entry()
    expect(parseEntry(JSON.stringify(noRouter))).not.toBeNull()
  })
})

describe("routerKeys", () => {
  test("plain site/app router", () => {
    expect(routerKeys("siteio-blog@docker")).toEqual(["blog"])
  })

  test("canonical router of a site with custom domains: exact key first, then the stripped one", () => {
    expect(routerKeys("siteio-blog-canonical@docker")).toEqual(["blog-canonical", "blog"])
  })

  test("tenant key keeps its -- separator", () => {
    expect(routerKeys("siteio-blog--friend-com@docker")).toEqual(["blog--friend-com"])
  })

  test.each([undefined, "", "api-router@file", "mcp-router@file", "siteio-@docker", "siteio-", "dashboard@internal"])(
    "routers that are not a site or app give no key: %p",
    (name) => {
      expect(routerKeys(name)).toEqual([])
    }
  )
})

describe("isBot", () => {
  test.each([
    undefined,
    "",
    "   ",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36",
    "curl/8.4.0",
    "Wget/1.21",
    "python-requests/2.31",
    "Go-http-client/2.0",
    "facebookexternalhit/1.1",
    "Slackbot-LinkExpanding 1.0",
    "UptimeRobot/2.0",
    "Mozilla/5.0 (compatible; AhrefsBot/7.0)",
    "GPTBot/1.0",
  ])("flags %p as a bot", (ua) => {
    expect(isBot(ua)).toBe(true)
  })

  test.each([
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
  ])("lets a real browser through: %p", (ua) => {
    expect(isBot(ua)).toBe(false)
  })
})

describe("cleanPath", () => {
  test.each([
    ["/", "/"],
    ["/posts/1", "/posts/1"],
    ["/posts/1?", "/posts/1"],
    ["/_siteio/edit?code=SECRET123", "/_siteio/edit"],
    ["/callback?code=abc&state=xyz", "/callback"],
    ["/?token=abc&utm_source=hn", "/?utm_source=hn"],
    ["/?utm_source=hn&utm_medium=social&utm_campaign=launch&utm_term=t&utm_content=c&x=1",
      "/?utm_source=hn&utm_medium=social&utm_campaign=launch&utm_term=t&utm_content=c"],
    ["/?UTM_SOURCE=hn", "/"],
    ["/a#frag?code=x", "/a"],
  ])("%p → %p", (input, expected) => {
    expect(cleanPath(input)).toBe(expected)
  })

  test("never throws on a malformed percent-encoding", () => {
    expect(cleanPath("/%E0%A4%A?code=1")).toBe("/%E0%A4%A")
  })
})

describe("isPageview", () => {
  test("a browser GET of an HTML page is a pageview", () => {
    expect(isPageview(entry())).toBe(true)
  })

  test.each<[string, Partial<AccessLogEntry>]>([
    ["HEAD", { RequestMethod: "HEAD" }],
    ["POST", { RequestMethod: "POST" }],
    ["304", { DownstreamStatus: 304 }],
    ["404", { DownstreamStatus: 404 }],
    ["500", { DownstreamStatus: 500 }],
    ["JSON", { "downstream_Content-Type": "application/json" }],
    ["CSS", { "downstream_Content-Type": "text/css" }],
    ["no content type", { "downstream_Content-Type": undefined }],
    ["bot", { "request_User-Agent": "Googlebot/2.1" }],
    ["siteio editor", { RequestPath: "/_siteio/edit" }],
    ["MCP", { RequestPath: "/mcp/sse" }],
    ["PocketBase API", { RequestPath: "/api/collections/posts/records" }],
    ["well-known", { RequestPath: "/.well-known/oauth-authorization-server" }],
  ])("not a pageview: %s", (_, over) => {
    expect(isPageview(entry(over))).toBe(false)
  })

  test("a path that merely starts with the letters 'api' is still a pageview", () => {
    expect(isPageview(entry({ RequestPath: "/apiary" }))).toBe(true)
  })

  test("content type is matched case-insensitively", () => {
    expect(isPageview(entry({ "downstream_Content-Type": "Text/HTML" }))).toBe(true)
  })
})

describe("statusClass", () => {
  test.each([[200, "2xx"], [204, "2xx"], [301, "3xx"], [404, "4xx"], [499, "4xx"], [503, "5xx"]] as const)(
    "%p → %p",
    (status, cls) => {
      expect(statusClass(status)).toBe(cls)
    }
  )

  test.each([0, 100, 600, -1, 200.5])("%p has no class", (status) => {
    expect(statusClass(status)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/__tests__/unit/analytics-classify.test.ts`
Expected: FAIL with "Cannot find module '../../lib/agent/analytics/classify'".

- [ ] **Step 3: Implement**

Append to `src/types.ts`:

```ts
// --- Traffic analytics (ANALYTICS_URL) ---
// Batch POSTed every minute; built from Traefik's access log in
// src/lib/agent/analytics/. `name` is the storage key (tenant sites: `blog--friend-com`).

export type AnalyticsKind = "site" | "app"

export interface AnalyticsPageview {
  ts: string // ISO request start
  kind: AnalyticsKind
  name: string
  owner?: string // site's current deployedBy; apps have none
  host: string
  path: string // query stripped except utm_*
  referrer?: string
  userAgent?: string
  ip: string
  status: number
  durationMs: number
}

export interface AnalyticsTraffic {
  kind: AnalyticsKind
  name: string
  owner?: string
  requests: number // every request in the batch, bots included
  bytes: number
  status: { "2xx": number; "3xx": number; "4xx": number; "5xx": number }
  bots: number
  p50Ms: number
  p95Ms: number
}

export interface AnalyticsBatch {
  version: 1
  agent: string // agent domain
  from: string // ISO, earliest request in the batch
  to: string // ISO, latest request in the batch
  pageviews: AnalyticsPageview[]
  traffic: AnalyticsTraffic[]
}
```

Create `src/lib/agent/analytics/classify.ts`:

```ts
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
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/__tests__/unit/analytics-classify.test.ts && bun run typecheck`
Expected: PASS. If a browser user agent in the "real browser" list matches `BOT_RE`, tighten the regex. Never loosen the bot list to make the test pass.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/lib/agent/analytics/classify.ts src/__tests__/unit/analytics-classify.test.ts
git commit -m "feat: classify Traefik access-log lines for analytics"
```

---

### Task 3: Real visitor IP behind Cloudflare

**Files:**
- Create: `src/lib/agent/analytics/client-ip.ts`
- Test: `src/__tests__/unit/analytics-client-ip.test.ts`

**Interfaces:**
- Consumes: `AccessLogEntry` (Task 2), including `"request_Cf-Connecting-Ip"?: string`
- Produces:
  - `parseIp(ip: string): { version: 4 | 6; value: bigint } | null`. IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is returned as version 4.
  - `isCloudflareIp(ip: string): boolean`
  - `clientIp(entry: AccessLogEntry): string`, the visitor IP to send

**Rule:** use `CF-Connecting-IP` only if (a) Traefik's `ClientHost` is inside a Cloudflare range **and** (b) the header holds one valid IP. Otherwise use `ClientHost`. Anyone can send the header to the origin directly, so without (a) the IP could be faked.

- [ ] **Step 1: Check the Cloudflare ranges are current**

Run: `curl -s https://www.cloudflare.com/ips-v4; echo; curl -s https://www.cloudflare.com/ips-v6`
Compare with `CLOUDFLARE_RANGES` in Step 4 and use the fetched list if they differ.

- [ ] **Step 2: Write the failing tests**

Create `src/__tests__/unit/analytics-client-ip.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { clientIp, isCloudflareIp, parseIp } from "../../lib/agent/analytics/client-ip"
import type { AccessLogEntry } from "../../lib/agent/analytics/classify"

const entry = (over: Partial<AccessLogEntry> = {}): AccessLogEntry => ({
  StartUTC: "2026-10-10T12:00:03Z",
  RouterName: "siteio-blog@docker",
  RequestMethod: "GET",
  RequestHost: "blog.chuut.com",
  RequestPath: "/",
  DownstreamStatus: 200,
  DownstreamContentSize: 10,
  Duration: 1_000_000,
  ClientHost: "203.0.113.9",
  ...over,
})

describe("parseIp", () => {
  test.each(["1.2.3.4", "0.0.0.0", "255.255.255.255", "::", "::1", "2606:4700::1", "2606:4700:0:0:0:0:0:1", "::ffff:1.2.3.4"])(
    "accepts %p",
    (ip) => {
      expect(parseIp(ip)).not.toBeNull()
    }
  )

  test.each([
    "",
    " ",
    "1.2.3",
    "1.2.3.4.5",
    "256.1.1.1",
    "1.2.3.-1",
    "01.2.3.4x",
    "1.2.3.4, 5.6.7.8", // a list, as X-Forwarded-For would carry
    "1:2:3:4:5:6:7:8:9",
    "2606:4700::1::2",
    "gggg::1",
    "12345::1",
    "[2606:4700::1]",
    "localhost",
    "1.2.3.4:443",
  ])("rejects %p", (ip) => {
    expect(parseIp(ip)).toBeNull()
  })

  test("IPv4-mapped IPv6 is treated as IPv4", () => {
    expect(parseIp("::ffff:1.2.3.4")).toEqual(parseIp("1.2.3.4"))
  })
})

describe("isCloudflareIp", () => {
  test.each(["173.245.48.1", "104.16.0.0", "104.23.255.255", "172.70.1.2", "2606:4700::1", "2a06:98c0::1", "::ffff:162.158.1.1"])(
    "%p is Cloudflare",
    (ip) => {
      expect(isCloudflareIp(ip)).toBe(true)
    }
  )

  test.each(["104.15.255.255", "104.32.0.0", "203.0.113.9", "10.0.0.1", "127.0.0.1", "2606:4701::1", "::1", "", "garbage"])(
    "%p is not Cloudflare",
    (ip) => {
      expect(isCloudflareIp(ip)).toBe(false)
    }
  )
})

describe("clientIp", () => {
  test("direct visitor, no header → ClientHost", () => {
    expect(clientIp(entry())).toBe("203.0.113.9")
  })

  test("through Cloudflare → the header's visitor IP", () => {
    expect(clientIp(entry({ ClientHost: "172.70.1.2", "request_Cf-Connecting-Ip": "198.51.100.7" }))).toBe("198.51.100.7")
  })

  test("through Cloudflare over IPv6 → the header's visitor IP", () => {
    expect(clientIp(entry({ ClientHost: "2606:4700::6810:1", "request_Cf-Connecting-Ip": "2001:db8::5" }))).toBe("2001:db8::5")
  })

  test("SPOOF: header sent straight to the origin by a non-Cloudflare IP is ignored", () => {
    expect(clientIp(entry({ ClientHost: "203.0.113.9", "request_Cf-Connecting-Ip": "8.8.8.8" }))).toBe("203.0.113.9")
  })

  test.each(["", "   ", "not-an-ip", "1.2.3.4, 5.6.7.8", "999.1.1.1"])(
    "through Cloudflare with a bad header %p → falls back to ClientHost",
    (bad) => {
      expect(clientIp(entry({ ClientHost: "172.70.1.2", "request_Cf-Connecting-Ip": bad }))).toBe("172.70.1.2")
    }
  )

  test("surrounding whitespace in the header is trimmed", () => {
    expect(clientIp(entry({ ClientHost: "172.70.1.2", "request_Cf-Connecting-Ip": " 198.51.100.7 " }))).toBe("198.51.100.7")
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/__tests__/unit/analytics-client-ip.test.ts`
Expected: FAIL with "Cannot find module '../../lib/agent/analytics/client-ip'".

- [ ] **Step 4: Implement**

Create `src/lib/agent/analytics/client-ip.ts`:

```ts
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
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test src/__tests__/unit/analytics-client-ip.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent/analytics/client-ip.ts src/__tests__/unit/analytics-client-ip.test.ts
git commit -m "feat: real visitor IP behind Cloudflare, header trusted only from Cloudflare"
```

---

### Task 4: Build a batch from entries

**Files:**
- Create: `src/lib/agent/analytics/batch.ts`
- Test: `src/__tests__/unit/analytics-batch.test.ts`

**Interfaces:**
- Consumes: `AccessLogEntry`, `routerKeys`, `isBot`, `isPageview`, `cleanPath`, `statusClass` (Task 2); `AnalyticsBatch`, `AnalyticsKind` (Task 2); `clientIp` (Task 3)
- Produces:
  - `interface Resolved { kind: AnalyticsKind; name: string; owner?: string }`
  - `type Resolve = (key: string) => Resolved | null`
  - `buildBatch(agent: string, entries: AccessLogEntry[], resolve: Resolve): AnalyticsBatch | null`. Returns `null` when no entry belongs to a known site or app.
  - `percentile(sorted: number[], p: number): number`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/unit/analytics-batch.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { buildBatch, percentile, type Resolve } from "../../lib/agent/analytics/batch"
import type { AccessLogEntry } from "../../lib/agent/analytics/classify"

const BROWSER = "Mozilla/5.0 (Macintosh) Firefox/130.0"

const entry = (over: Partial<AccessLogEntry> = {}): AccessLogEntry => ({
  StartUTC: "2026-10-10T12:00:03Z",
  RouterName: "siteio-blog@docker",
  RequestMethod: "GET",
  RequestHost: "blog.chuut.com",
  RequestPath: "/",
  DownstreamStatus: 200,
  DownstreamContentSize: 100,
  Duration: 10_000_000,
  ClientHost: "203.0.113.9",
  "request_User-Agent": BROWSER,
  "downstream_Content-Type": "text/html",
  ...over,
})

const known: Record<string, ReturnType<Resolve>> = {
  blog: { kind: "site", name: "blog", owner: "pierre" },
  "blog--friend-com": { kind: "site", name: "blog--friend-com" },
  web: { kind: "app", name: "web" },
}
const resolve: Resolve = (key) => known[key] ?? null

describe("buildBatch", () => {
  test("no entries → null (nothing to send)", () => {
    expect(buildBatch("chuut.com", [], resolve)).toBeNull()
  })

  test("only unknown routers → null", () => {
    const entries = [
      entry({ RouterName: "api-router@file" }),
      entry({ RouterName: undefined }),
      entry({ RouterName: "siteio-deleted@docker" }),
    ]
    expect(buildBatch("chuut.com", entries, resolve)).toBeNull()
  })

  test("a pageview carries owner, cleaned path, referrer, ip and ms duration", () => {
    const batch = buildBatch(
      "chuut.com",
      [entry({ RequestPath: "/p?code=SECRET&utm_source=hn", "request_Referer": "https://hn.example/", Duration: 12_400_000 })],
      resolve
    )!
    expect(batch.version).toBe(1)
    expect(batch.agent).toBe("chuut.com")
    expect(batch.pageviews).toEqual([
      {
        ts: "2026-10-10T12:00:03.000Z",
        kind: "site",
        name: "blog",
        owner: "pierre",
        host: "blog.chuut.com",
        path: "/p?utm_source=hn",
        referrer: "https://hn.example/",
        userAgent: BROWSER,
        ip: "203.0.113.9",
        status: 200,
        durationMs: 12,
      },
    ])
    expect(JSON.stringify(batch)).not.toContain("SECRET")
  })

  test("behind Cloudflare the pageview carries the visitor IP, not Cloudflare's", () => {
    const batch = buildBatch(
      "chuut.com",
      [entry({ ClientHost: "172.70.1.2", "request_Cf-Connecting-Ip": "198.51.100.7" })],
      resolve
    )!
    expect(batch.pageviews[0]!.ip).toBe("198.51.100.7")
  })

  test("a canonical router resolves to its site", () => {
    const batch = buildBatch("chuut.com", [entry({ RouterName: "siteio-blog-canonical@docker" })], resolve)!
    expect(batch.traffic.map((t) => t.name)).toEqual(["blog"])
  })

  test("tenant and app keys resolve; apps have no owner", () => {
    const batch = buildBatch(
      "chuut.com",
      [entry({ RouterName: "siteio-blog--friend-com@docker" }), entry({ RouterName: "siteio-web@docker" })],
      resolve
    )!
    const byName = Object.fromEntries(batch.traffic.map((t) => [t.name, t]))
    expect(byName["blog--friend-com"]!.kind).toBe("site")
    expect(byName.web!.kind).toBe("app")
    expect("owner" in byName.web!).toBe(false)
  })

  test("traffic counts every request, bots included; pageviews exclude bots and assets", () => {
    const entries = [
      entry(),
      entry({ "request_User-Agent": "Googlebot/2.1" }),
      entry({ RequestPath: "/app.css", "downstream_Content-Type": "text/css", DownstreamContentSize: 900 }),
      entry({ DownstreamStatus: 404 }),
      entry({ DownstreamStatus: 503 }),
      entry({ DownstreamStatus: 301 }),
      entry({ DownstreamStatus: 0 }), // client went away: counted as a request, no class
    ]
    const batch = buildBatch("chuut.com", entries, resolve)!
    expect(batch.pageviews).toHaveLength(1)
    const t = batch.traffic[0]!
    expect(t.requests).toBe(7)
    expect(t.bots).toBe(1)
    expect(t.bytes).toBe(100 * 6 + 900)
    expect(t.status).toEqual({ "2xx": 3, "3xx": 1, "4xx": 1, "5xx": 1 })
  })

  test("from/to span the batch even when lines are out of order", () => {
    const batch = buildBatch(
      "chuut.com",
      [entry({ StartUTC: "2026-10-10T12:00:30Z" }), entry({ StartUTC: "2026-10-10T12:00:01Z" }), entry({ StartUTC: "2026-10-10T12:00:59Z" })],
      resolve
    )!
    expect(batch.from).toBe("2026-10-10T12:00:01.000Z")
    expect(batch.to).toBe("2026-10-10T12:00:59.000Z")
  })

  test("an entry with an unparseable StartUTC is skipped, not sent as Invalid Date", () => {
    const batch = buildBatch("chuut.com", [entry({ StartUTC: "garbage" }), entry()], resolve)!
    expect(batch.traffic[0]!.requests).toBe(1)
    expect(JSON.stringify(batch)).not.toContain("Invalid")
  })

  test("resolve is called once per key, not once per line", () => {
    let calls = 0
    const counting: Resolve = (key) => {
      calls++
      return resolve(key)
    }
    buildBatch("chuut.com", Array.from({ length: 500 }, () => entry()), counting)
    expect(calls).toBe(1)
  })

  test("empty referrer and user agent are omitted, not sent as empty strings", () => {
    const batch = buildBatch("chuut.com", [entry({ "request_Referer": "" })], resolve)!
    expect("referrer" in batch.pageviews[0]!).toBe(false)
  })
})

describe("percentile", () => {
  test("empty → 0", () => {
    expect(percentile([], 0.5)).toBe(0)
  })
  test("single value", () => {
    expect(percentile([7], 0.95)).toBe(7)
  })
  test("nearest-rank on sorted input", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(xs, 0.5)).toBe(50)
    expect(percentile(xs, 0.95)).toBe(95)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/__tests__/unit/analytics-batch.test.ts`
Expected: FAIL with "Cannot find module '../../lib/agent/analytics/batch'".

- [ ] **Step 3: Implement**

Create `src/lib/agent/analytics/batch.ts`:

```ts
// Pure: turn a chunk of access-log entries into one AnalyticsBatch.
import type { AnalyticsBatch, AnalyticsKind, AnalyticsPageview, AnalyticsTraffic } from "../../../types.ts"
import { cleanPath, isBot, isPageview, routerKeys, statusClass, type AccessLogEntry } from "./classify.ts"
import { clientIp } from "./client-ip.ts"

export interface Resolved {
  kind: AnalyticsKind
  name: string
  owner?: string
}

// Looks a storage key up as a site, then as an app.
export type Resolve = (key: string) => Resolved | null

// Nearest-rank percentile of an ascending array.
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!
}

export function buildBatch(agent: string, entries: AccessLogEntry[], resolve: Resolve): AnalyticsBatch | null {
  const cache = new Map<string, Resolved | null>()
  const lookup = (key: string): Resolved | null => {
    if (!cache.has(key)) cache.set(key, resolve(key))
    return cache.get(key)!
  }
  const owning = (e: AccessLogEntry): Resolved | null => {
    for (const key of routerKeys(e.RouterName)) {
      const hit = lookup(key)
      if (hit) return hit
    }
    return null
  }

  const pageviews: AnalyticsPageview[] = []
  const traffic = new Map<string, AnalyticsTraffic & { durations: number[] }>()
  let from = Infinity
  let to = -Infinity

  for (const e of entries) {
    const target = owning(e)
    if (!target) continue
    const time = Date.parse(e.StartUTC)
    if (Number.isNaN(time)) continue
    from = Math.min(from, time)
    to = Math.max(to, time)
    const durationMs = Math.round(e.Duration / 1e6)
    const owner = target.owner ? { owner: target.owner } : {}

    let t = traffic.get(target.name)
    if (!t) {
      t = {
        kind: target.kind,
        name: target.name,
        ...owner,
        requests: 0,
        bytes: 0,
        status: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 },
        bots: 0,
        p50Ms: 0,
        p95Ms: 0,
        durations: [],
      }
      traffic.set(target.name, t)
    }
    t.requests++
    t.bytes += e.DownstreamContentSize
    const cls = statusClass(e.DownstreamStatus)
    if (cls) t.status[cls]++
    if (isBot(e["request_User-Agent"])) t.bots++
    t.durations.push(durationMs)

    if (isPageview(e)) {
      pageviews.push({
        ts: new Date(time).toISOString(),
        kind: target.kind,
        name: target.name,
        ...owner,
        host: e.RequestHost,
        path: cleanPath(e.RequestPath),
        ...(e["request_Referer"] ? { referrer: e["request_Referer"] } : {}),
        ...(e["request_User-Agent"] ? { userAgent: e["request_User-Agent"] } : {}),
        ip: clientIp(e),
        status: e.DownstreamStatus,
        durationMs,
      })
    }
  }

  if (traffic.size === 0) return null

  return {
    version: 1,
    agent,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    pageviews,
    traffic: [...traffic.values()].map(({ durations, ...t }) => {
      const sorted = durations.sort((a, b) => a - b)
      return { ...t, p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95) }
    }),
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/__tests__/unit/analytics-batch.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/analytics/batch.ts src/__tests__/unit/analytics-batch.test.ts
git commit -m "feat: build analytics batches from access-log entries"
```

---

### Task 5: Access-log tailer with rotation

**Files:**
- Create: `src/lib/agent/analytics/tailer.ts`
- Test: `src/__tests__/unit/analytics-tailer.test.ts`

**Interfaces:**
- Produces:
  - `interface TailerOptions { path: string; reopen: () => void; maxBytes?: number; chunkBytes?: number; settleMs?: number; now?: () => number }`
  - `class AccessLogTailer { constructor(opts: TailerOptions); readChunk(): { lines: string[]; more: boolean } }`
  - State file: `<path>.offset`. Rotated file: `<path>.1`.

**How it works.** The state is one byte offset. It applies to `<path>.1` when that file exists, else to `<path>`.

- **Rotated file present:** read it to the end. Delete it once fully read **and** unchanged for `settleMs` (5 s), so Traefik has reopened before we drop it. Then reset the offset to 0.
- **Main file:** read from the offset, and consume only up to the last `\n`.
  - If the file is shorter than the offset (truncated or recreated), restart at 0.
  - If a full chunk holds no `\n` (an absurdly long line), skip bytes until that line's newline, so the tailer can't stall or return a fragment.
  - Once the offset passes `maxBytes`, rename the file to `<path>.1` and call `reopen()`.
- `more` is true when unread bytes remain, so the pump can loop.

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/unit/analytics-tailer.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AccessLogTailer, type TailerOptions } from "../../lib/agent/analytics/tailer"

let dir: string
let path: string
let reopens: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "siteio-tailer-"))
  path = join(dir, "access.log")
  reopens = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const make = (over: Partial<TailerOptions> = {}) =>
  new AccessLogTailer({ path, reopen: () => reopens++, settleMs: 0, ...over })

// Drain everything the tailer will give right now.
function drain(t: AccessLogTailer): string[] {
  const out: string[] = []
  for (let i = 0; i < 1000; i++) {
    const { lines, more } = t.readChunk()
    out.push(...lines)
    if (!more) return out
  }
  throw new Error("tailer never reported caught up")
}

describe("AccessLogTailer", () => {
  test("missing file → nothing, no crash", () => {
    expect(make().readChunk()).toEqual({ lines: [], more: false })
  })

  test("reads complete lines once, then only new ones", () => {
    writeFileSync(path, "a\nb\n")
    const t = make()
    expect(drain(t)).toEqual(["a", "b"])
    expect(drain(t)).toEqual([])
    appendFileSync(path, "c\n")
    expect(drain(t)).toEqual(["c"])
  })

  test("a half-written last line is held back until its newline arrives", () => {
    writeFileSync(path, 'a\n{"half":')
    const t = make()
    expect(drain(t)).toEqual(["a"])
    appendFileSync(path, "true}\n")
    expect(drain(t)).toEqual(['{"half":true}'])
  })

  test("the offset survives a restart (new tailer instance)", () => {
    writeFileSync(path, "a\n")
    drain(make())
    appendFileSync(path, "b\n")
    expect(drain(make())).toEqual(["b"])
  })

  test("a corrupt offset file restarts from 0 instead of crashing", () => {
    writeFileSync(path, "a\n")
    writeFileSync(`${path}.offset`, "not a number")
    expect(drain(make())).toEqual(["a"])
  })

  test("a truncated file is re-read from the start", () => {
    writeFileSync(path, "aaaa\nbbbb\n")
    const t = make()
    drain(t)
    writeFileSync(path, "c\n")
    expect(drain(t)).toEqual(["c"])
  })

  test("blank lines and CRLF endings are not returned as entries", () => {
    writeFileSync(path, "a\r\n\n\nb\n")
    expect(drain(make())).toEqual(["a", "b"])
  })

  test("reads in bounded chunks and reports more until caught up", () => {
    writeFileSync(path, Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n") + "\n")
    const t = make({ chunkBytes: 64 })
    const first = t.readChunk()
    expect(first.more).toBe(true)
    expect(first.lines.length).toBeLessThan(100)
    expect([...first.lines, ...drain(t)]).toHaveLength(100)
  })

  test("a single line longer than a chunk is skipped, not looped on forever", () => {
    writeFileSync(path, "x".repeat(200) + "\nok\n")
    expect(drain(make({ chunkBytes: 64 }))).toEqual(["ok"])
  })

  test("rotates past maxBytes: renames, reopens, then drains and deletes the old file", () => {
    let now = Date.now()
    writeFileSync(path, "a\nb\n")
    const t = make({ maxBytes: 3, settleMs: 5000, now: () => now })
    expect(drain(t)).toEqual(["a", "b"])
    expect(reopens).toBe(1)
    expect(existsSync(`${path}.1`)).toBe(true) // not deleted: not quiet long enough yet
    // Traefik writes one late line into the old file before it reopens.
    appendFileSync(`${path}.1`, "late\n")
    writeFileSync(path, "new\n")
    now += 10_000
    expect(drain(t)).toEqual(["late", "new"])
    expect(existsSync(`${path}.1`)).toBe(false)
  })

  test("a rotated file ending in a never-finished line is still deleted once quiet", () => {
    writeFileSync(`${path}.1`, 'a\n{"cut off')
    writeFileSync(path, "b\n")
    expect(drain(make())).toEqual(["a", "b"])
    expect(existsSync(`${path}.1`)).toBe(false)
  })

  test("the rotated file is kept until it has been quiet for settleMs", () => {
    let now = 1_000_000
    writeFileSync(path, "a\n")
    const t = make({ maxBytes: 1, settleMs: 5000, now: () => now })
    drain(t)
    const rotated = `${path}.1`
    utimesSync(rotated, now / 1000, now / 1000)
    drain(t)
    expect(existsSync(rotated)).toBe(true)
    now += 6000
    drain(t)
    expect(existsSync(rotated)).toBe(false)
  })

  test("a leftover rotated file from a crash is drained before the live file", () => {
    writeFileSync(`${path}.1`, "old\n")
    writeFileSync(path, "new\n")
    expect(drain(make())).toEqual(["old", "new"])
  })

  test("the offset file is written next to the log", () => {
    writeFileSync(path, "a\n")
    drain(make())
    expect(readFileSync(`${path}.offset`, "utf-8").trim()).toBe("2")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/__tests__/unit/analytics-tailer.test.ts`
Expected: FAIL with "Cannot find module '../../lib/agent/analytics/tailer'".

- [ ] **Step 3: Implement**

Create `src/lib/agent/analytics/tailer.ts`:

```ts
// Reads Traefik's access log incrementally. One byte offset, persisted next to
// the log, applies to `<path>.1` while a rotated file exists, else to `<path>`.
// Rotation is rename + reopen (Traefik reopens its log on USR1); the old file
// is deleted only once fully read and quiet, so late lines are not lost.
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "fs"

export interface TailerOptions {
  path: string
  reopen: () => void
  maxBytes?: number
  chunkBytes?: number
  settleMs?: number
  now?: () => number
}

const MAX_BYTES = 20 * 1024 * 1024
const CHUNK_BYTES = 4 * 1024 * 1024
const SETTLE_MS = 5000

export class AccessLogTailer {
  private path: string
  private rotated: string
  private statePath: string
  private reopen: () => void
  private maxBytes: number
  private chunkBytes: number
  private settleMs: number
  private now: () => number
  // Inside a line longer than one chunk: drop bytes up to its newline. In
  // memory only; after a restart the leftover tail is one unparseable line.
  private skipping = false

  constructor(opts: TailerOptions) {
    this.path = opts.path
    this.rotated = `${opts.path}.1`
    this.statePath = `${opts.path}.offset`
    this.reopen = opts.reopen
    this.maxBytes = opts.maxBytes ?? MAX_BYTES
    this.chunkBytes = opts.chunkBytes ?? CHUNK_BYTES
    this.settleMs = opts.settleMs ?? SETTLE_MS
    this.now = opts.now ?? Date.now
  }

  readChunk(): { lines: string[]; more: boolean } {
    const draining = existsSync(this.rotated)
    const file = draining ? this.rotated : this.path
    if (!existsSync(file)) return { lines: [], more: false }

    const { size, mtimeMs } = statSync(file)
    let offset = this.loadOffset()
    if (offset > size) offset = 0

    const { lines, consumed } = this.read(file, offset, size)
    offset += consumed
    this.saveOffset(offset)

    if (draining) {
      // consumed === 0 with bytes left: a cut-off last line that will never end.
      if (offset < size && consumed > 0) return { lines, more: true }
      // Fully read: drop it once Traefik has clearly moved on to the new file.
      if (this.now() - mtimeMs < this.settleMs) return { lines, more: false }
      rmSync(this.rotated, { force: true })
      this.saveOffset(0)
      return { lines, more: existsSync(this.path) }
    }

    if (offset >= this.maxBytes) {
      renameSync(this.path, this.rotated)
      this.reopen()
      return { lines, more: true }
    }
    return { lines, more: consumed > 0 && offset < size }
  }

  // Complete lines from `offset`, at most one chunk. A chunk with no newline
  // that fills the whole chunk is one oversized line: skip it.
  private read(file: string, offset: number, size: number): { lines: string[]; consumed: number } {
    const length = Math.min(this.chunkBytes, size - offset)
    if (length <= 0) return { lines: [], consumed: 0 }
    const buf = Buffer.alloc(length)
    const fd = openSync(file, "r")
    try {
      readSync(fd, buf, 0, length, offset)
    } finally {
      closeSync(fd)
    }
    let start = 0
    if (this.skipping) {
      const nl = buf.indexOf(0x0a)
      if (nl === -1) return { lines: [], consumed: length }
      this.skipping = false
      start = nl + 1
    }
    const end = buf.lastIndexOf(0x0a)
    if (end < start) {
      // No complete line yet. A whole chunk of one line: start skipping it.
      if (start === 0 && length === this.chunkBytes) {
        this.skipping = true
        return { lines: [], consumed: length }
      }
      return { lines: [], consumed: start }
    }
    const lines = buf
      .subarray(start, end)
      .toString("utf-8")
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.trim() !== "")
    return { lines, consumed: end + 1 }
  }

  private loadOffset(): number {
    try {
      const n = Number(readFileSync(this.statePath, "utf-8").trim())
      return Number.isSafeInteger(n) && n >= 0 ? n : 0
    } catch {
      return 0
    }
  }

  private saveOffset(offset: number): void {
    writeFileSync(this.statePath, String(offset))
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/__tests__/unit/analytics-tailer.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/analytics/tailer.ts src/__tests__/unit/analytics-tailer.test.ts
git commit -m "feat: access-log tailer with offset and rotation"
```

---

### Task 6: Traefik writes the access log

**Files:**
- Modify: `src/lib/agent/traefik.ts:40-50` (config), `:68-75` (constructor), `:141-144` (static config), `:350-360` (container args), new methods
- Test: `src/__tests__/unit/traefik-manager.test.ts`

**Interfaces:**
- Produces:
  - `TraefikConfig.accessLog?: boolean`
  - `export function accessLogPath(dataDir: string): string`, returns `<dataDir>/traefik-logs/access.log`
  - `TraefikManager.reopenAccessLog(): void`, which sends `USR1` to `siteio-traefik` and logs on failure without throwing

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/unit/traefik-manager.test.ts`, inside the `describe` (also add `accessLogPath` to the import):

```ts
  it("writes no access log by default", () => {
    expect(makeTraefik().generateStaticConfig()).not.toContain("accessLog")
  })

  it("writes a JSON access log keeping only the headers analytics needs", () => {
    const yml = makeTraefik({ accessLog: true }).generateStaticConfig()
    expect(yml).toContain("accessLog:")
    expect(yml).toContain("filePath: /logs/access.log")
    expect(yml).toContain("format: json")
    expect(yml).toMatch(/headers:\s+defaultMode: drop/)
    expect(yml).toContain("User-Agent: keep")
    expect(yml).toContain("Referer: keep")
    expect(yml).toContain("Content-Type: keep")
    expect(yml).toContain("Cf-Connecting-Ip: keep")
    // Credentials must never reach the log file.
    expect(yml).not.toContain("Authorization: keep")
    expect(yml).not.toContain("Cookie: keep")
    expect(yml).toContain("ClientUsername: drop")
  })

  it("the access log lives outside the read-only config mount", () => {
    expect(accessLogPath(TEST_DATA_DIR)).toBe(join(TEST_DATA_DIR, "traefik-logs", "access.log"))
    makeTraefik({ accessLog: true })
    expect(existsSync(join(TEST_DATA_DIR, "traefik-logs"))).toBe(true)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/__tests__/unit/traefik-manager.test.ts`
Expected: FAIL (`accessLogPath` is not exported; `accessLog` is missing from the YAML).

- [ ] **Step 3: Implement**

In `src/lib/agent/traefik.ts`:

Add after the `TRAEFIK_CONTAINER_NAME` constant:

```ts
const LOGS_DIRNAME = "traefik-logs"

// Host path of Traefik's access log (mounted at /logs). Kept out of
// <dataDir>/traefik, which Traefik mounts read-only.
export function accessLogPath(dataDir: string): string {
  return join(dataDir, LOGS_DIRNAME, "access.log")
}
```

Add to `TraefikConfig`:

```ts
  accessLog?: boolean // write a JSON access log for traffic analytics (set iff ANALYTICS_URL)
```

Add the field `private logsDir: string`, set it in the constructor after `certsDir`, and create it when needed:

```ts
    this.logsDir = join(config.dataDir, LOGS_DIRNAME)
```

```ts
    if (config.accessLog && !existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true })
    }
```

In `generateStaticConfig`, add `accessLog` to the destructuring and build this block before the `return`:

```ts
    // Read by the agent's analytics tailer (src/lib/agent/analytics). Only the
    // headers it needs are kept, so credentials and cookies never hit disk.
    const accessLogConfig = accessLog
      ? `

accessLog:
  filePath: /logs/access.log
  format: json
  fields:
    defaultMode: keep
    names:
      ClientUsername: drop
    headers:
      defaultMode: drop
      names:
        User-Agent: keep
        Referer: keep
        Content-Type: keep
        Cf-Connecting-Ip: keep`
      : ""
```

and change the end of the template from

```ts
log:
  level: INFO
`.trim()
```

to

```ts
log:
  level: INFO${accessLogConfig}
`.trim()
```

In `start()`, after the certs mount in `args`:

```ts
    if (this.config.accessLog) {
      args.push("-v", `${this.logsDir}:/logs`)
    }
```

Add a method next to `stop()`:

```ts
  // Traefik closes and reopens its access log on USR1 (used after rotation).
  reopenAccessLog(): void {
    const result = spawnSync({
      cmd: ["docker", "kill", "--signal", "USR1", TRAEFIK_CONTAINER_NAME],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      console.log(`> Traefik access-log reopen failed: ${result.stderr.toString().trim()}`)
    }
  }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/__tests__/unit/traefik-manager.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify the YAML against real Traefik**

Run, from the repo root:

```bash
bun -e 'import {TraefikManager} from "./src/lib/agent/traefik.ts"; const d="/tmp/siteio-tcheck"; console.log(new TraefikManager({dataDir:d,domain:"x.test",httpPort:80,httpsPort:443,fileServerPort:3000,accessLog:true}).generateStaticConfig())' > /tmp/siteio-tcheck.yml
docker run --rm -v /tmp/siteio-tcheck.yml:/etc/traefik/traefik.yml:ro traefik:v3.7 --configFile=/etc/traefik/traefik.yml & sleep 4; docker ps -q --filter ancestor=traefik:v3.7 | xargs -r docker stop
```

Expected: Traefik starts with no "field not found" or YAML error in its output.

- [ ] **Step 6: Verify the logged field names against real Traefik**

The code reads `request_User-Agent`, `request_Referer`, `downstream_Content-Type` and `request_Cf-Connecting-Ip`. Confirm Traefik writes exactly those keys. Run Traefik with the generated static config plus a minimal file-provider router to any backend, mount a temp dir at `/logs`, then:

```bash
curl -s -H "CF-Connecting-IP: 198.51.100.7" -H "Referer: https://ref.example/" -A "Mozilla/5.0 test" http://localhost:<port>/
cat <tempdir>/access.log
```

Expected: one JSON line containing those four keys with the values sent. If a key is spelled differently (for example, the `Cf-Connecting-Ip` config entry not matching), fix the `names:` entry and the `AccessLogEntry` field together, and record the real spelling in a comment.

If Docker is not available locally, run Steps 5 and 6 on a server later and say so in the hand-off; don't claim they were verified.

- [ ] **Step 7: Commit**

```bash
git add src/lib/agent/traefik.ts src/__tests__/unit/traefik-manager.test.ts
git commit -m "feat: Traefik JSON access log when analytics is enabled"
```

---

### Task 7: Analytics hook, pump, and server wiring

**Files:**
- Modify: `src/lib/agent/hooks.ts` (add `Analytics`, update the header comment)
- Create: `src/lib/agent/analytics/pump.ts`
- Modify: `src/lib/agent/server.ts:19` (import), `:180-205` (field and constructor), `:235-245` (Traefik `accessLog`), `start()` near `autoDeployer.start()`, `stop()`
- Test: `src/__tests__/unit/analytics-pump.test.ts`, `src/__tests__/api/analytics.test.ts`

**Interfaces:**
- Consumes: `AccessLogTailer` (Task 5), `buildBatch`, `Resolve` (Task 4), `parseEntry` (Task 2), `accessLogPath`, `TraefikManager.reopenAccessLog` (Task 6), `AgentConfig.analyticsUrl` (Task 1)
- Produces:
  - `class Analytics { constructor(url: string, log?: Log); send(batch: AnalyticsBatch): Promise<void> }` in `hooks.ts`
  - `class AnalyticsPump { constructor(deps: PumpDeps, intervalMs?: number); start(): void; stop(): void; tick(): Promise<void> }`
  - `interface PumpDeps { agent: string; tailer: Pick<AccessLogTailer, "readChunk">; resolve: Resolve; send: (b: AnalyticsBatch) => Promise<void>; log: (line: string) => void }`
  - `AgentServer.analyticsTickForTest(): Promise<void>`

- [ ] **Step 1: Write the failing pump tests**

Create `src/__tests__/unit/analytics-pump.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { AnalyticsPump, type PumpDeps } from "../../lib/agent/analytics/pump"
import type { AnalyticsBatch } from "../../types"

const line = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    StartUTC: "2026-10-10T12:00:03Z",
    RouterName: "siteio-blog@docker",
    RequestMethod: "GET",
    RequestHost: "blog.chuut.com",
    RequestPath: "/",
    DownstreamStatus: 200,
    DownstreamContentSize: 10,
    Duration: 1_000_000,
    ClientHost: "203.0.113.9",
    "request_User-Agent": "Mozilla/5.0 Firefox/130.0",
    "downstream_Content-Type": "text/html",
    ...over,
  })

// A tailer that hands out pre-baked chunks.
function chunks(...cs: string[][]): PumpDeps["tailer"] {
  return {
    readChunk: () => {
      const lines = cs.shift() ?? []
      return { lines, more: cs.length > 0 }
    },
  }
}

function deps(over: Partial<PumpDeps> = {}) {
  const sent: AnalyticsBatch[] = []
  const logs: string[] = []
  const d: PumpDeps = {
    agent: "chuut.com",
    tailer: chunks([line()]),
    resolve: (key) => (key === "blog" ? { kind: "site", name: "blog" } : null),
    send: async (b) => {
      sent.push(b)
    },
    log: (l) => logs.push(l),
    ...over,
  }
  return { d, sent, logs }
}

describe("AnalyticsPump", () => {
  test("one tick sends one batch per chunk", async () => {
    const { d, sent } = deps({ tailer: chunks([line()], [line(), line()]) })
    await new AnalyticsPump(d).tick()
    expect(sent.map((b) => b.traffic[0]!.requests)).toEqual([1, 2])
  })

  test("nothing new → nothing sent", async () => {
    const { d, sent } = deps({ tailer: chunks([]) })
    await new AnalyticsPump(d).tick()
    expect(sent).toHaveLength(0)
  })

  test("garbage lines are skipped; the valid ones in the same chunk still go out", async () => {
    const { d, sent } = deps({ tailer: chunks(["{broken", "", line(), "null"]) })
    await new AnalyticsPump(d).tick()
    expect(sent[0]!.traffic[0]!.requests).toBe(1)
  })

  test("a failing endpoint is logged and the batch dropped; the next chunk still goes out", async () => {
    let calls = 0
    const sent: AnalyticsBatch[] = []
    const { d, logs } = deps({
      tailer: chunks([line()], [line()]),
      send: async (b) => {
        if (calls++ === 0) throw new Error("ECONNREFUSED")
        sent.push(b)
      },
    })
    await new AnalyticsPump(d).tick()
    expect(sent).toHaveLength(1)
    expect(logs.some((l) => l.includes("ECONNREFUSED"))).toBe(true)
  })

  test("a throwing tailer (disk error) is logged, not thrown", async () => {
    const { d, logs } = deps({
      tailer: {
        readChunk: () => {
          throw new Error("EACCES")
        },
      },
    })
    await new AnalyticsPump(d).tick()
    expect(logs.some((l) => l.includes("EACCES"))).toBe(true)
  })

  test("ticks never overlap while a send hangs", async () => {
    let release!: () => void
    let sends = 0
    const { d } = deps({
      tailer: { readChunk: () => ({ lines: [line()], more: false }) },
      send: () => {
        sends++
        return new Promise<void>((r) => (release = r))
      },
    })
    const pump = new AnalyticsPump(d)
    const first = pump.tick()
    await pump.tick() // returns at once: a tick is already running
    expect(sends).toBe(1)
    release()
    await first
  })

  test("a tailer that always says more is cut off after a bounded number of chunks", async () => {
    let reads = 0
    const { d } = deps({
      tailer: {
        readChunk: () => {
          reads++
          return { lines: [line()], more: true }
        },
      },
    })
    await new AnalyticsPump(d).tick()
    expect(reads).toBeLessThanOrEqual(50)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/__tests__/unit/analytics-pump.test.ts`
Expected: FAIL with "Cannot find module '../../lib/agent/analytics/pump'".

- [ ] **Step 3: Implement the pump**

Create `src/lib/agent/analytics/pump.ts`:

```ts
// Every interval: drain the access log in chunks, turn each chunk into a batch,
// send it. Best-effort: a failed batch is logged and dropped. Ticks never overlap.
import type { AnalyticsBatch } from "../../../types.ts"
import { buildBatch, type Resolve } from "./batch.ts"
import { parseEntry, type AccessLogEntry } from "./classify.ts"
import type { AccessLogTailer } from "./tailer.ts"

export interface PumpDeps {
  agent: string
  tailer: Pick<AccessLogTailer, "readChunk">
  resolve: Resolve
  send: (batch: AnalyticsBatch) => Promise<void>
  log: (line: string) => void
}

const INTERVAL_MS = 60_000
// Bounds one tick (50 × 4 MiB); a backlog finishes on later ticks.
const MAX_CHUNKS_PER_TICK = 50

export class AnalyticsPump {
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false

  constructor(
    private deps: PumpDeps,
    private intervalMs: number = INTERVAL_MS
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (let i = 0; i < MAX_CHUNKS_PER_TICK; i++) {
        const { lines, more } = this.deps.tailer.readChunk()
        const entries = lines.map(parseEntry).filter((e): e is AccessLogEntry => e !== null)
        const batch = buildBatch(this.deps.agent, entries, this.deps.resolve)
        if (batch) {
          try {
            await this.deps.send(batch)
          } catch (err) {
            this.deps.log(`Analytics batch dropped: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        if (!more) break
      }
    } catch (err) {
      this.deps.log(`Analytics tick failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.running = false
    }
  }
}
```

- [ ] **Step 4: Run the pump tests**

Run: `bun test src/__tests__/unit/analytics-pump.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing end-to-end test**

Create `src/__tests__/api/analytics.test.ts`. It mirrors the setup in `src/__tests__/api/hooks.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "fs"
import { dirname, join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server"
import { accessLogPath } from "../../lib/agent/traefik"
import { FakeRuntime } from "../helpers/fake-runtime"
import type { AgentConfig, AnalyticsBatch } from "../../types"

const API_KEY = "analytics-test-key"

let batches: AnalyticsBatch[]
let status: number
let hang: boolean
let endpoint: ReturnType<typeof Bun.serve>
let dir: string

beforeEach(() => {
  batches = []
  status = 202
  hang = false
  endpoint = Bun.serve({
    port: 0,
    async fetch(req) {
      if (hang) await new Promise(() => {})
      batches.push((await req.json()) as AnalyticsBatch)
      return new Response("{}", { status })
    },
  })
  dir = mkdtempSync(join(tmpdir(), "siteio-analytics-"))
})

afterEach(() => {
  endpoint.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

function makeServer(analyticsUrl: string | undefined): AgentServer {
  const config: AgentConfig = {
    apiKey: API_KEY,
    dataDir: join(dir, "data"),
    domain: "analytics.test",
    maxUploadSize: 1024 * 1024,
    httpPort: 80,
    httpsPort: 443,
    skipTraefik: true,
    analyticsUrl,
  }
  return new AgentServer(config, new FakeRuntime())
}

const url = () => `http://localhost:${endpoint.port}/api/ingest?key=s3cret`

async function deploySite(server: AgentServer, name: string): Promise<void> {
  const zip = zipSync({ "public/index.html": new TextEncoder().encode("<h1>hi</h1>") })
  const res = await server.handleRequestForTest(
    new Request(`http://localhost/sites/${name}`, {
      method: "POST",
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/zip", "X-Siteio-User": "pierre" },
      body: zip,
    })
  )
  expect(res.status).toBe(200)
}

function writeLog(...lines: Record<string, unknown>[]): void {
  const path = accessLogPath(join(dir, "data"))
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, lines.map((l) => JSON.stringify(l) + "\n").join(""))
}

const hit = (over: Record<string, unknown> = {}) => ({
  StartUTC: "2026-10-10T12:00:03Z",
  RouterName: "siteio-blog@docker",
  RequestMethod: "GET",
  RequestHost: "blog.analytics.test",
  RequestPath: "/?code=SECRET",
  DownstreamStatus: 200,
  DownstreamContentSize: 10,
  Duration: 1_000_000,
  ClientHost: "203.0.113.9",
  "request_User-Agent": "Mozilla/5.0 Firefox/130.0",
  "downstream_Content-Type": "text/html",
  ...over,
})

describe("analytics", () => {
  test("no analyticsUrl: no tick, no file needed, nothing sent", async () => {
    const server = makeServer(undefined)
    await server.analyticsTickForTest()
    expect(batches).toHaveLength(0)
    expect(existsSync(accessLogPath(join(dir, "data")))).toBe(false)
  })

  test("a pageview on a deployed site reaches the endpoint with its owner, secret query stripped", async () => {
    const server = makeServer(url())
    await deploySite(server, "blog")
    writeLog(hit(), hit({ RouterName: "api-router@file" }))
    await server.analyticsTickForTest()
    expect(batches).toHaveLength(1)
    const b = batches[0]!
    expect(b.agent).toBe("analytics.test")
    expect(b.pageviews).toHaveLength(1)
    expect(b.pageviews[0]!.owner).toBe("pierre")
    expect(b.pageviews[0]!.path).toBe("/")
    expect(JSON.stringify(b)).not.toContain("SECRET")
    expect(b.traffic).toHaveLength(1) // the api-router line is ignored
  })

  test("lines are sent once: a second tick with no new lines sends nothing", async () => {
    const server = makeServer(url())
    await deploySite(server, "blog")
    writeLog(hit())
    await server.analyticsTickForTest()
    await server.analyticsTickForTest()
    expect(batches).toHaveLength(1)
  })

  test("a deleted site's lines are dropped, not sent with a stale name", async () => {
    const server = makeServer(url())
    writeLog(hit({ RouterName: "siteio-ghost@docker" }))
    await server.analyticsTickForTest()
    expect(batches).toHaveLength(0)
  })

  test("an endpoint returning 500 does not break the next batch", async () => {
    const server = makeServer(url())
    await deploySite(server, "blog")
    status = 500
    writeLog(hit())
    await server.analyticsTickForTest()
    status = 202
    writeLog(hit())
    await server.analyticsTickForTest()
    expect(batches).toHaveLength(2) // both arrived; the 500 was logged, not retried
  })

  test("the agent keeps serving API requests while the endpoint hangs", async () => {
    const server = makeServer(url())
    await deploySite(server, "blog")
    hang = true
    writeLog(hit())
    void server.analyticsTickForTest()
    const res = await server.handleRequestForTest(
      new Request("http://localhost/sites", { headers: { "X-API-Key": API_KEY } })
    )
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `bun test src/__tests__/api/analytics.test.ts`
Expected: FAIL with "analyticsTickForTest is not a function".

- [ ] **Step 7: Implement the hook and the server wiring**

In `src/lib/agent/hooks.ts`, extend the header comment:

```ts
//   - Analytics (ANALYTICS_URL): receives a batch of pageviews + traffic counters every minute.
```

and add at the end:

```ts
export class Analytics {
  constructor(
    private analyticsUrl: string,
    private log: Log = defaultLog
  ) {}

  async send(batch: AnalyticsBatch): Promise<void> {
    await postHook("Analytics", this.analyticsUrl, batch, this.log)
  }
}
```

with `import type { AnalyticsBatch } from "../../types.ts"` at the top.

Note: `postHook` never rejects; it logs a non-2xx status or a network error itself. So the pump's `catch` is only a guard, and the 500 case in the end-to-end test is logged by `postHook`.

In `src/lib/agent/server.ts`:

- Import: change `import { Pager, Ranking } from "./hooks.ts"` to `import { Analytics, Pager, Ranking } from "./hooks.ts"`. Add `import { AnalyticsPump } from "./analytics/pump.ts"`, `import { AccessLogTailer } from "./analytics/tailer.ts"`, `import type { Resolved } from "./analytics/batch.ts"`, and add `accessLogPath` to the existing `./traefik.ts` import.
- Field after `ranking`:

```ts
  // Sends pageviews + traffic from Traefik's access log; null unless ANALYTICS_URL is set.
  private analytics: AnalyticsPump | null = null
```

- In the `TraefikManager` constructor call, add `accessLog: !!config.analyticsUrl,`.
- After the `if (!config.skipTraefik) { ... }` block (so `this.traefik` is set):

```ts
    if (config.analyticsUrl) {
      const hook = new Analytics(config.analyticsUrl)
      this.analytics = new AnalyticsPump({
        agent: config.domain,
        tailer: new AccessLogTailer({
          path: accessLogPath(config.dataDir),
          reopen: () => this.traefik?.reopenAccessLog(),
        }),
        resolve: (key) => this.resolveAnalyticsKey(key),
        send: (batch) => hook.send(batch),
        log: (line) => console.log(`> ${line}`),
      })
    }
```

- New private method next to `pageApp`:

```ts
  // A Traefik router key → the site or app it serves, for analytics. Sites carry
  // their last deployer as an owner hint; apps record none.
  private resolveAnalyticsKey(key: string): Resolved | null {
    const site = this.storage.get(key)
    if (site) return { kind: "site", name: key, ...(site.deployedBy ? { owner: site.deployedBy } : {}) }
    if (this.appStorage.exists(key)) return { kind: "app", name: key }
    return null
  }
```

- In `start()`, after the `autoDeployer.start()` line:

```ts
    this.analytics?.start()
```

- In `stop()`, after `this.autoDeployer.stop()`:

```ts
    this.analytics?.stop()
```

- Next to `handleRequestForTest`:

```ts
  async analyticsTickForTest(): Promise<void> {
    await this.analytics?.tick()
  }
```

- [ ] **Step 8: Run all new tests, the full suite and typecheck**

Run: `bun test src/__tests__/unit/analytics-pump.test.ts src/__tests__/api/analytics.test.ts && bun test && bun run typecheck`
Expected: all PASS. Report the real output; don't summarize failures as passes.

- [ ] **Step 9: Commit**

```bash
git add src/lib/agent/hooks.ts src/lib/agent/analytics/pump.ts src/lib/agent/server.ts src/__tests__/unit/analytics-pump.test.ts src/__tests__/api/analytics.test.ts
git commit -m "feat: push pageviews and traffic to ANALYTICS_URL every minute"
```

---

### Task 8: Land the plane

- [ ] **Step 1: Full quality gate**

Run: `bun run typecheck && bun test`
Expected: PASS.

- [ ] **Step 2: Push** (project rule: work is not complete until pushed)

```bash
git pull --rebase
git push
git status
```

Expected: "Your branch is up to date with 'origin/main'".

Releasing and rolling out to the 5 servers is **not** part of this plan. That happens only when the user asks for a release.

---

## Open points (not built; flagged for the user)

- **Cloudflare ranges change rarely but do change:** they are embedded in `client-ip.ts`. Re-check https://www.cloudflare.com/ips/ when releasing.
- **Owner hint for apps:** `App` has no `deployedBy`, so app events carry no `owner`. Adding it would mean persisting the deployer on app deploys.
- **Disk while the endpoint is down:** batches are dropped (best-effort). Logs are still read and rotated, so the disk stays bounded at about 2 × 20 MiB.
