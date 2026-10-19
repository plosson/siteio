// Counts events per key (a client IP) in fixed windows. In memory only: a
// restart forgets it. Finished windows are dropped when the map grows large.
export class RateLimiter {
  private windows = new Map<string, { count: number; endsAt: number }>()

  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now
  ) {}

  // Whether `key` has used up this window. Doesn't count.
  blocked(key: string): boolean {
    const w = this.windows.get(key)
    return !!w && w.endsAt > this.now() && w.count >= this.limit
  }

  // Counts one event before the work it guards, so parallel requests can't all
  // pass the check first. False when this one exceeds the limit.
  tryHit(key: string): boolean {
    this.hit(key)
    return this.windows.get(key)!.count <= this.limit
  }

  // Gives back one event counted by tryHit (the work turned out fine).
  undo(key: string): void {
    const w = this.windows.get(key)
    if (w && w.endsAt > this.now() && w.count > 0) w.count--
  }

  hit(key: string): void {
    const now = this.now()
    const w = this.windows.get(key)
    if (w && w.endsAt > now) {
      w.count++
      return
    }
    if (this.windows.size >= 10_000) {
      for (const [k, v] of this.windows) if (v.endsAt <= now) this.windows.delete(k)
    }
    this.windows.set(key, { count: 1, endsAt: now + this.windowMs })
  }

  size(): number {
    return this.windows.size
  }
}
