// Outbound deploy hooks. Each is a plain JSON POST to an operator-set URL;
// best-effort: a hook outage never fails or slows a deploy.
//   - Pager (PAGERIO_URL): pages the operator on deploys/restarts. The URL is the secret.
//   - Ranking (RANKING_URL): reports each successful deploy to a ranking dashboard.
//   - Analytics (ANALYTICS_URL): receives a batch of pageviews + traffic counters every minute.
import type { AnalyticsBatch } from "../../types.ts"

const TIMEOUT_MS = 10_000

type Log = (line: string) => void
const defaultLog: Log = (line) => console.log(`> ${line}`)

// Fire-and-forget: callers don't await, so the returned promise never rejects.
async function postHook(name: string, url: string, body: unknown, log: Log): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) log(`${name} returned ${res.status}: ${await res.text().catch(() => "")}`)
  } catch (err) {
    log(`${name} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export interface Page {
  title: string
  message: string
  url?: string
}

export class Pager {
  constructor(
    private pagerUrl: string,
    private log: Log = defaultLog
  ) {}

  async notify(page: Page): Promise<void> {
    await postHook("Pager", this.pagerUrl, { ...page, group: "siteio" }, this.log)
  }
}

export interface RankedDeploy {
  user?: string
  version: string
  url: string
}

export class Ranking {
  constructor(
    private rankingUrl: string,
    private log: Log = defaultLog
  ) {}

  // The endpoint requires `user`: anonymous deploys are not ranked.
  async report({ user, version, url }: RankedDeploy): Promise<void> {
    if (!user) return
    await postHook("Ranking", this.rankingUrl, { user, version, url }, this.log)
  }
}

export class Analytics {
  constructor(
    private analyticsUrl: string,
    private log: Log = defaultLog
  ) {}

  async send(batch: AnalyticsBatch): Promise<void> {
    await postHook("Analytics", this.analyticsUrl, batch, this.log)
  }
}
