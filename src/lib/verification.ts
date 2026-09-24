/**
 * DNS and certificate verification utilities
 */

import * as dns from "dns"
import * as tls from "tls"

export interface VerificationOptions {
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
}

export interface VerificationResult {
  success: boolean
  attempts: number
  error?: string
  status?: number // HTTP status, for URL checks
}

type ProgressCallback = (attempt: number, maxAttempts: number) => void

/**
 * Calculate exponential backoff delay
 */
function getBackoffDelay(attempt: number, initialDelayMs: number, maxDelayMs: number): number {
  const delay = initialDelayMs * Math.pow(2, attempt - 1)
  return Math.min(delay, maxDelayMs)
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Check if DNS resolves by performing an A record lookup
 */
export async function checkDNS(domain: string): Promise<boolean> {
  return new Promise((resolve) => {
    dns.resolve4(domain, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        resolve(false)
      } else {
        resolve(true)
      }
    })
  })
}

/**
 * Check if the domain has a valid Let's Encrypt certificate
 * Returns "valid" if cert is from Let's Encrypt, "pending" if no cert or self-signed,
 * "error" on connection failure
 */
export async function checkCertificate(
  domain: string,
  timeoutMs: number = 5000
): Promise<"valid" | "pending" | "error"> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host: domain,
        port: 443,
        timeout: timeoutMs,
        rejectUnauthorized: false, // We'll check the cert manually
      },
      () => {
        try {
          const cert = socket.getPeerCertificate()
          socket.destroy()

          if (!cert || !cert.issuer) {
            resolve("pending")
            return
          }

          // Check if issued by Let's Encrypt
          // Let's Encrypt certs have issuer.O containing "Let's Encrypt"
          const issuerOrg = cert.issuer.O || ""
          if (issuerOrg.includes("Let's Encrypt")) {
            resolve("valid")
          } else {
            // Could be Traefik's default cert or other self-signed
            resolve("pending")
          }
        } catch {
          socket.destroy()
          resolve("pending")
        }
      }
    )

    socket.on("error", () => {
      socket.destroy()
      resolve("error")
    })

    socket.on("timeout", () => {
      socket.destroy()
      resolve("error")
    })
  })
}

/**
 * Wait for DNS to propagate with retries and exponential backoff
 */
export async function waitForDNS(
  domain: string,
  options: VerificationOptions = {},
  onProgress?: ProgressCallback
): Promise<VerificationResult> {
  const maxAttempts = options.maxAttempts ?? 5
  const initialDelayMs = options.initialDelayMs ?? 2000
  const maxDelayMs = options.maxDelayMs ?? 30000

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onProgress?.(attempt, maxAttempts)

    const success = await checkDNS(domain)
    if (success) {
      return { success: true, attempts: attempt }
    }

    if (attempt < maxAttempts) {
      const delay = getBackoffDelay(attempt, initialDelayMs, maxDelayMs)
      await sleep(delay)
    }
  }

  return { success: false, attempts: maxAttempts, error: "DNS verification timed out" }
}

/**
 * Wait for Let's Encrypt certificate with retries and exponential backoff
 */
export async function waitForCertificate(
  domain: string,
  options: VerificationOptions = {},
  onProgress?: ProgressCallback
): Promise<VerificationResult> {
  const maxAttempts = options.maxAttempts ?? 5
  const initialDelayMs = options.initialDelayMs ?? 2000
  const maxDelayMs = options.maxDelayMs ?? 30000

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onProgress?.(attempt, maxAttempts)

    const status = await checkCertificate(domain)
    if (status === "valid") {
      return { success: true, attempts: attempt }
    }

    if (attempt < maxAttempts) {
      const delay = getBackoffDelay(attempt, initialDelayMs, maxDelayMs)
      await sleep(delay)
    }
  }

  return { success: false, attempts: maxAttempts, error: "Certificate verification timed out" }
}

export type UrlCheck = { ok: true; status: number } | { ok: false; reason: string; status?: number }

/**
 * Fetch a public URL through the normal trust store and classify the outcome
 * the way a deploy cares about: is the app actually served over HTTPS yet?
 */
export async function checkUrl(
  url: string,
  timeoutMs: number = 10000,
  fetchFn: typeof fetch = fetch
): Promise<UrlCheck> {
  let response: Response
  try {
    response = await fetchFn(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    const code = (err as { code?: string }).code ?? ""
    const message = err instanceof Error ? err.message : String(err)
    if (/CERT|SELF_SIGNED/.test(code)) {
      return { ok: false, reason: `TLS certificate not trusted yet (${message})` }
    }
    if (code === "ENOTFOUND") {
      return { ok: false, reason: "DNS does not resolve for this host" }
    }
    return { ok: false, reason: message }
  }

  const status = response.status
  if (status === 404) {
    // Traefik's own 404: no router matches this host
    const body = (await response.text().catch(() => "")).trim()
    if (body === "404 page not found") {
      return { ok: false, status, reason: "the proxy has no route for this host (Traefik 404)" }
    }
  }
  if (status === 502 || status === 503 || status === 504) {
    return { ok: false, status, reason: `the proxy cannot reach the app (HTTP ${status})` }
  }
  if (status >= 500) {
    return { ok: false, status, reason: `the app answers HTTP ${status}` }
  }
  return { ok: true, status }
}

/**
 * Poll a URL at a fixed interval until checkUrl succeeds or the timeout runs
 * out. The error on failure is the last reason seen.
 */
export async function waitForUrl(
  url: string,
  options: { timeoutMs?: number; intervalMs?: number; fetchFn?: typeof fetch; now?: () => number; sleepFn?: (ms: number) => Promise<void> } = {},
  onProgress?: (attempt: number, check: UrlCheck) => void
): Promise<VerificationResult> {
  const timeoutMs = options.timeoutMs ?? 90000
  const intervalMs = options.intervalMs ?? 3000
  const now = options.now ?? Date.now
  const sleepFn = options.sleepFn ?? sleep
  const deadline = now() + timeoutMs

  let attempt = 0
  for (;;) {
    attempt++
    const check = await checkUrl(url, 10000, options.fetchFn)
    onProgress?.(attempt, check)
    if (check.ok) {
      return { success: true, attempts: attempt, status: check.status }
    }
    if (now() + intervalMs > deadline) {
      return { success: false, attempts: attempt, error: check.reason, status: check.status }
    }
    await sleepFn(intervalMs)
  }
}
