import { spawnSync } from "bun"

/**
 * Open a URL in the user's default browser. Failures are swallowed — callers
 * always print the URL to the terminal as a fallback.
 */
export function openBrowser(url: string): void {
  try {
    const cmd = process.platform === "darwin" ? ["open", url] : ["xdg-open", url]
    spawnSync({ cmd, stdout: "pipe", stderr: "pipe" })
  } catch {
    // Browser open failed silently - URL is already displayed to user
  }
}
