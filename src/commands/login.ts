import * as p from "@clack/prompts"
import chalk from "chalk"
import { saveConfig, loadConfig, getConfigPath } from "../config/loader.ts"
import { formatSuccess, formatError } from "../utils/output.ts"
import { decodeToken } from "../utils/token.ts"
import type { LoginOptions } from "../types.ts"

export async function loginCommand(options: LoginOptions): Promise<void> {
  p.intro(chalk.bgCyan(" siteio login "))

  // Check for token from env var or CLI option
  const token = options.token || process.env.SITEIO_TOKEN

  let apiUrl: string
  let apiKey: string

  if (token) {
    // Decode token to get URL and API key
    try {
      const decoded = decodeToken(token)
      apiUrl = decoded.url
      apiKey = decoded.apiKey
      p.log.info(`Using token for ${apiUrl}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid token"
      console.error(formatError(message))
      process.exit(1)
    }
  } else {
    // Interactive prompts
    const existingConfig = loadConfig()

    const answers = await p.group(
      {
        apiUrl: () =>
          p.text({
            message: "API URL:",
            placeholder: "https://api.axel.siteio.me",
            initialValue: options.apiUrl || existingConfig.apiUrl || "",
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

  // Save config
  saveConfig({
    apiUrl,
    apiKey,
  })

  p.outro(formatSuccess(`Config saved to ${getConfigPath()}`))
  process.exit(0)
}
