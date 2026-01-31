import * as p from "@clack/prompts"
import chalk from "chalk"
import { randomBytes } from "crypto"
import { AgentServer } from "../../lib/agent/server.ts"
import { formatError } from "../../utils/output.ts"
import { encodeToken } from "../../utils/token.ts"
import { loadAgentConfig, updateAgentConfig } from "../../config/agent.ts"
import type { AgentConfig } from "../../types.ts"

function generateApiKey(): string {
  return randomBytes(32).toString("hex")
}

function parseSize(size: string): number {
  const match = size.match(/^(\d+)(B|KB|MB|GB)?$/i)
  if (!match) return 50 * 1024 * 1024 // Default 50MB

  const value = parseInt(match[1]!, 10)
  const unit = (match[2] || "B").toUpperCase()

  switch (unit) {
    case "KB":
      return value * 1024
    case "MB":
      return value * 1024 * 1024
    case "GB":
      return value * 1024 * 1024 * 1024
    default:
      return value
  }
}

export async function startAgentCommand(): Promise<void> {
  const dataDir = process.env.SITEIO_DATA_DIR || "/data"

  // Load persistent config
  const persistedConfig = loadAgentConfig(dataDir)
  if (!persistedConfig.apiKey) {
    persistedConfig.apiKey = generateApiKey()
  }

  // Read configuration from environment variables or prompt
  let domain = process.env.SITEIO_DOMAIN || persistedConfig.domain

  if (!domain) {
    p.intro(chalk.bgCyan(" siteio agent "))

    const result = await p.text({
      message: "Domain for this agent:",
      placeholder: "example.siteio.me",
      validate: (value) => {
        if (!value) return "Domain is required"
        if (!value.includes(".")) return "Please enter a valid domain"
      },
    })

    if (p.isCancel(result)) {
      p.cancel("Setup cancelled")
      process.exit(0)
    }

    domain = result
  }

  const apiKey = process.env.SITEIO_API_KEY || persistedConfig.apiKey
  const maxUploadSize = parseSize(process.env.SITEIO_MAX_UPLOAD_SIZE || "50MB")
  const httpPort = parseInt(process.env.SITEIO_HTTP_PORT || "80", 10)
  const httpsPort = parseInt(process.env.SITEIO_HTTPS_PORT || "443", 10)
  const email = process.env.SITEIO_EMAIL

  if (!email) {
    console.error(formatError("SITEIO_EMAIL environment variable is required for Let's Encrypt certificates"))
    console.error(chalk.gray("  Set it in your systemd service file or environment"))
    process.exit(1)
  }

  // Save config for persistence
  updateAgentConfig(dataDir, { apiKey, domain })

  const config: AgentConfig = {
    apiKey,
    dataDir,
    domain,
    maxUploadSize,
    httpPort,
    httpsPort,
    email,
  }

  // Generate connection info
  const apiUrl = `https://api.${domain}`
  const token = encodeToken(apiUrl, apiKey)

  console.log(chalk.cyan("siteio-agent starting..."))
  console.log("")
  console.log(`  Domain:     ${chalk.bold(domain)}`)
  console.log(`  Data dir:   ${dataDir}`)
  console.log(`  Max upload: ${maxUploadSize / 1024 / 1024}MB`)
  console.log(`  Ports:      ${httpPort} (HTTP), ${httpsPort} (HTTPS)`)
  console.log("")

  // Connection credentials - easy to copy/paste
  console.log(chalk.cyan.bold("─── Connection Credentials ───"))
  console.log("")
  console.log(`  URL:     ${apiUrl}`)
  console.log(`  API Key: ${apiKey}`)
  console.log(`  Token:   ${token}`)
  console.log("")
  console.log(chalk.cyan.bold("──────────────────────────────"))
  console.log("")
  console.log(chalk.gray("Users can connect with:"))
  console.log(chalk.gray(`  siteio login -t ${token}`))
  console.log("")

  const server = new AgentServer(config)

  // Handle shutdown signals
  const shutdown = () => {
    console.log("\n> Shutting down...")
    server.stop()
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  try {
    await server.start()
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error(formatError(`Failed to start agent: ${message}`))
    process.exit(2)
  }
}
