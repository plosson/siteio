import chalk from "chalk"
import { loadConfig } from "../config/loader.ts"
import { openBrowser } from "../utils/browser.ts"
import { formatError, formatSuccess } from "../utils/output.ts"

/**
 * Resolve which server to open. With no argument, use the current server.
 * With an argument, match a stored server by domain (exact, then partial),
 * mirroring the resolution used by `siteio logout`.
 */
function resolveServer(domain?: string): { apiUrl: string; apiKey: string; domain: string } {
  const config = loadConfig()
  const domains = Object.keys(config.servers ?? {})

  if (domains.length === 0) {
    console.error(formatError("Not logged in"))
    console.error(chalk.gray("  Run 'siteio login -t <token>' to connect"))
    process.exit(1)
  }

  if (!domain) {
    // loadConfig() flattens the current server's credentials to the root.
    if (!config.current || !config.apiUrl || !config.apiKey) {
      console.error(formatError("No current server selected"))
      console.error(chalk.gray(`  Available: ${domains.join(", ")}`))
      process.exit(1)
    }
    return { apiUrl: config.apiUrl, apiKey: config.apiKey, domain: config.current }
  }

  const matches = domains.includes(domain) ? [domain] : domains.filter((d) => d.includes(domain))
  if (matches.length === 0) {
    console.error(formatError(`Server '${domain}' not found`))
    console.error(chalk.gray(`  Available: ${domains.join(", ")}`))
    process.exit(1)
  }
  if (matches.length > 1) {
    console.error(formatError(`Multiple servers match '${domain}'`))
    console.error(chalk.gray(`  Matches: ${matches.join(", ")}`))
    process.exit(1)
  }

  const matched = matches[0]!
  const server = config.servers![matched]!
  return { apiUrl: server.apiUrl, apiKey: server.apiKey, domain: matched }
}

export async function uiCommand(domain?: string): Promise<void> {
  const server = resolveServer(domain)

  const uiUrl = `${server.apiUrl}/ui`
  // The API key is passed via query string so the UI can authenticate without
  // a manual paste; the UI strips it from the URL immediately on load. Never
  // print the key-bearing URL to the terminal (it would leak into scrollback).
  const launchUrl = `${uiUrl}?key=${encodeURIComponent(server.apiKey)}`

  openBrowser(launchUrl)

  console.error(formatSuccess(`Opening ${uiUrl}`))
  console.error(chalk.gray("  If your browser didn't open, run 'siteio ui' again or paste the URL above."))
}
