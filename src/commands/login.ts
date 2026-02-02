import * as p from "@clack/prompts"
import chalk from "chalk"
import {
  addServer,
  switchServer,
  listServers,
  extractDomain,
  getUsername,
  setUsername,
} from "../config/loader.ts"
import { formatSuccess, formatError } from "../utils/output.ts"
import { decodeToken } from "../utils/token.ts"
import type { LoginOptions } from "../types.ts"

export async function loginCommand(options: LoginOptions): Promise<void> {
  p.intro(chalk.bgCyan(" siteio login "))

  // Check for token from env var or CLI option
  const token = options.token || process.env.SITEIO_TOKEN

  // If a domain argument is provided (switch to existing server)
  if (options.domain) {
    const targetDomain = options.domain
    const server = switchServer(targetDomain)
    if (!server) {
      // Try partial match
      const servers = listServers()
      const matches = servers.filter((s) => s.domain.includes(targetDomain))
      const singleMatch = matches.length === 1 ? matches[0] : null
      if (singleMatch) {
        const matched = switchServer(singleMatch.domain)
        if (matched) {
          p.outro(formatSuccess(`Switched to ${singleMatch.domain}`))
          process.exit(0)
        }
      }
      console.error(formatError(`Server '${targetDomain}' not found`))
      const available = servers.map((s) => s.domain).join(", ")
      if (available) {
        console.error(chalk.gray(`  Available: ${available}`))
      }
      process.exit(1)
    }
    p.outro(formatSuccess(`Switched to ${targetDomain}`))
    process.exit(0)
  }

  let apiUrl: string
  let apiKey: string

  if (token) {
    // Decode token to get URL and API key
    try {
      const decoded = decodeToken(token)
      apiUrl = decoded.url
      apiKey = decoded.apiKey
      p.log.info(`Using token for ${extractDomain(apiUrl)}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid token"
      console.error(formatError(message))
      process.exit(1)
    }
  } else {
    // No token - show server list if we have multiple, or prompt for new
    const servers = listServers()

    if (servers.length > 0) {
      // Show available servers and let user pick or add new
      const choices = [
        ...servers.map((s) => ({
          value: s.domain,
          label: s.current ? `${s.domain} ${chalk.green("(current)")}` : s.domain,
        })),
        { value: "__new__", label: chalk.cyan("+ Add new server") },
      ]

      const selected = await p.select({
        message: "Select a server:",
        options: choices,
      })

      if (p.isCancel(selected)) {
        p.cancel("Login cancelled")
        process.exit(0)
      }

      if (selected !== "__new__") {
        const server = switchServer(selected as string)
        if (server) {
          p.outro(formatSuccess(`Switched to ${selected}`))
          process.exit(0)
        }
      }
    }

    // Interactive prompts for new server
    const answers = await p.group(
      {
        apiUrl: () =>
          p.text({
            message: "API URL:",
            placeholder: "https://api.example.siteio.me",
            validate: (value) => {
              if (!value) return "API URL is required"
              try {
                new URL(value)
              } catch {
                return "Invalid URL format"
              }
            },
          }),

        apiKey: () =>
          p.password({
            message: "API Key:",
            validate: (value) => {
              if (!value) return "API Key is required"
              if (value.length < 8) return "API Key seems too short"
            },
          }),
      },
      {
        onCancel: () => {
          p.cancel("Login cancelled")
          process.exit(0)
        },
      }
    )

    apiUrl = answers.apiUrl as string
    apiKey = answers.apiKey as string
  }

  // Test connection
  const s = p.spinner()
  s.start("Testing connection")

  try {
    const response = await fetch(`${apiUrl}/health`, {
      headers: { "X-API-Key": apiKey },
    })

    if (!response.ok) {
      s.stop(chalk.red("Connection failed"))
      console.error(formatError(`Server returned ${response.status}`))
      process.exit(1)
    }

    s.stop(chalk.green("Connection successful"))
  } catch (err) {
    s.stop(chalk.red("Connection failed"))
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error(formatError(`Could not connect: ${message}`))
    process.exit(2)
  }

  // Save server config
  const domain = addServer(apiUrl, apiKey)

  // Prompt for username if not already set
  const existingUsername = getUsername()
  if (!existingUsername) {
    const username = await p.text({
      message: "Your name (for deploy attribution):",
      placeholder: "e.g., alice (press Enter to skip)",
    })

    if (!p.isCancel(username) && username && username.trim()) {
      setUsername(username.trim())
      p.log.success(`Username set to "${username.trim()}"`)
    }
  }

  p.outro(formatSuccess(`Logged in to ${domain}`))
  process.exit(0)
}
