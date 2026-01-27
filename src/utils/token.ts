import { deflateSync, inflateSync } from "zlib"

const SEPARATOR = "\n"

export interface TokenData {
  url: string
  apiKey: string
}

/**
 * Encode URL and API key into a compact token.
 * Format: base64url(deflate(url + '\n' + apiKey))
 */
export function encodeToken(url: string, apiKey: string): string {
  const payload = `${url}${SEPARATOR}${apiKey}`
  const compressed = deflateSync(Buffer.from(payload, "utf-8"))
  return toBase64Url(compressed)
}

/**
 * Decode a token back into URL and API key.
 * Throws if token is invalid.
 */
export function decodeToken(token: string): TokenData {
  try {
    const compressed = fromBase64Url(token)
    const payload = inflateSync(compressed).toString("utf-8")
    const separatorIndex = payload.indexOf(SEPARATOR)

    if (separatorIndex === -1) {
      throw new Error("Invalid token format")
    }

    const url = payload.slice(0, separatorIndex)
    const apiKey = payload.slice(separatorIndex + 1)

    if (!url || !apiKey) {
      throw new Error("Invalid token: missing URL or API key")
    }

    // Validate URL
    new URL(url)

    return { url, apiKey }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid token")) {
      throw err
    }
    throw new Error("Invalid token: could not decode")
  }
}

/**
 * Check if a string looks like a valid token.
 */
export function isValidToken(token: string): boolean {
  try {
    decodeToken(token)
    return true
  } catch {
    return false
  }
}

// Base64url encoding (URL-safe, no padding)
function toBase64Url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function fromBase64Url(str: string): Buffer {
  // Add padding back
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4)
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/")
  return Buffer.from(base64, "base64")
}
