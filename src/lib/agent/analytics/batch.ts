// Pure: turn a chunk of access-log entries into one AnalyticsBatch.
import type { AnalyticsBatch, AnalyticsKind, AnalyticsPageview, AnalyticsTraffic } from "../../../types.ts"
import { cleanPath, cleanReferrer, isBot, isPageview, routerKeys, statusClass, type AccessLogEntry } from "./classify.ts"
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
      const referrer = e["request_Referer"] ? cleanReferrer(e["request_Referer"]) : undefined
      pageviews.push({
        ts: new Date(time).toISOString(),
        kind: target.kind,
        name: target.name,
        ...owner,
        host: e.RequestHost,
        path: cleanPath(e.RequestPath),
        ...(referrer ? { referrer } : {}),
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
