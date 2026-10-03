// Pages the operator through a pagerio URL (PAGERIO_URL) when an app or site is
// deployed or restarted. A page is a plain JSON POST; the URL itself is the
// secret. Best-effort: a pager outage never fails or slows a deploy.
const TIMEOUT_MS = 10_000

export interface Page {
  title: string
  message: string
  url?: string
}

export class Pager {
  constructor(
    private pagerUrl: string,
    private log: (line: string) => void = (line) => console.log(`> ${line}`)
  ) {}

  // Fire-and-forget: callers don't await, so the returned promise never rejects.
  async notify(page: Page): Promise<void> {
    try {
      const res = await fetch(this.pagerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...page, group: "siteio" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) this.log(`Pager returned ${res.status}: ${await res.text().catch(() => "")}`)
    } catch (err) {
      this.log(`Pager failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
