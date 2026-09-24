/**
 * Post-deploy container checks. A deploy returns as soon as the containers are
 * started; these helpers watch them for a short window so crash loops, failed
 * sidecars and unhealthy services are reported instead of a false "deployed".
 */

import type { AppServiceStatus, AppStatus } from "../types.ts"

export interface ServiceProblem {
  service: string
  problem: string
}

/** Why a single service sample is unhealthy, or null when it looks fine. */
export function serviceProblem(s: AppServiceStatus): string | null {
  const code = s.exitCode !== undefined ? ` (exit code ${s.exitCode})` : ""
  switch (s.state) {
    case "restarting":
      // docker compose ps reports ExitCode 0 while restarting: not worth showing
      return "keeps restarting"
    case "dead":
      return `is dead${code}`
    case "missing":
      return s.primary ? "has no container" : null
    case "created":
      // Never started: usually a depends_on condition that did not pass
      return s.primary ? "was never started" : null
    case "exited":
      if (s.exitCode !== 0) return `exited${code}`
      // One-shot jobs (migrations) exit 0 by design; the primary must stay up
      return s.primary ? `exited${code}` : null
  }
  if (s.health === "unhealthy") return "is unhealthy"
  return null
}

export interface WatchOptions {
  windowMs?: number
  intervalMs?: number
  sleepFn?: (ms: number) => Promise<void>
}

/**
 * Sample the app's status over a window and return the services in a problem
 * state from the first sample that shows any. Sampling across a window matters
 * because a crash-looping container is briefly "running" between restarts.
 */
export async function watchServices(
  getStatus: () => Promise<AppStatus>,
  options: WatchOptions = {}
): Promise<ServiceProblem[]> {
  const windowMs = options.windowMs ?? 10000
  const intervalMs = options.intervalMs ?? 2000
  const sleepFn = options.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const samples = Math.max(1, Math.floor(windowMs / intervalMs) + 1)

  for (let i = 0; i < samples; i++) {
    if (i > 0) await sleepFn(intervalMs)
    const status = await getStatus()
    const problems = status.services.flatMap((s) => {
      const problem = serviceProblem(s)
      return problem ? [{ service: s.service, problem }] : []
    })
    if (problems.length > 0) return problems
  }
  return []
}
