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
function sleep(ms: number): Promise<void> {
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
