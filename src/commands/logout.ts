import * as p from "@clack/prompts"
import chalk from "chalk"
import { removeServer, listServers } from "../config/loader.ts"
import { formatSuccess, formatError } from "../utils/output.ts"

export async function logoutCommand(domain?: string): Promise<void> {
  p.intro(chalk.bgCyan(" siteio logout "))

  const servers = listServers()

  if (servers.length === 0) {
    console.error(formatError("No servers configured"))
    process.exit(1)
  }

  let targetDomain: string

  if (domain) {
    // Direct domain specified
    const exact = servers.find((s) => s.domain === domain)
    if (exact) {
      targetDomain = exact.domain
    } else {
      // Try partial match
      const matches = servers.filter((s) => s.domain.includes(domain))
      if (matches.length === 1 && matches[0]) {
        targetDomain = matches[0].domain
      } else if (matches.length > 1) {
        console.error(formatError(`Multiple servers match '${domain}'`))
        console.error(chalk.gray(`  Matches: ${matches.map((s) => s.domain).join(", ")}`))
        process.exit(1)
      } else {
        console.error(formatError(`Server '${domain}' not found`))
        const available = servers.map((s) => s.domain).join(", ")
        console.error(chalk.gray(`  Available: ${available}`))
        process.exit(1)
      }
    }
  } else {
    // Interactive selection
    const choices = servers.map((s) => ({
      value: s.domain,
      label: s.current ? `${s.domain} ${chalk.green("(current)")}` : s.domain,
    }))

    const selected = await p.select({
      message: "Select a server to remove:",
      options: choices,
    })

    if (p.isCancel(selected)) {
      p.cancel("Logout cancelled")
      process.exit(0)
    }

    targetDomain = selected as string
  }

  // Confirm removal
  const confirm = await p.confirm({
    message: `Remove ${targetDomain}?`,
  })

  if (p.isCancel(confirm) || !confirm) {
    p.cancel("Logout cancelled")
    process.exit(0)
  }

  const removed = removeServer(targetDomain)

  if (removed) {
    p.outro(formatSuccess(`Removed ${targetDomain}`))
  } else {
    console.error(formatError(`Failed to remove ${targetDomain}`))
    process.exit(1)
  }
}
