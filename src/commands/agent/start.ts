import chalk from "chalk"
import { randomBytes } from "crypto"
import { AgentServer } from "../../lib/agent/server.ts"
import { formatError } from "../../utils/output.ts"
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
  // Read configuration from environment variables
  const domain = process.env.SITEIO_DOMAIN
  if (!domain) {
    console.error(formatError("SITEIO_DOMAIN environment variable is required"))
    console.error(chalk.gray("  Example: SITEIO_DOMAIN=axel.siteio.me"))
    process.exit(1)
  }

  const apiKey = process.env.SITEIO_API_KEY || generateApiKey()
  const dataDir = process.env.SITEIO_DATA_DIR || "/data"
  const maxUploadSize = parseSize(process.env.SITEIO_MAX_UPLOAD_SIZE || "50MB")
  const httpPort = parseInt(process.env.SITEIO_HTTP_PORT || "80", 10)
  const httpsPort = parseInt(process.env.SITEIO_HTTPS_PORT || "443", 10)
  const email = process.env.SITEIO_EMAIL

  const config: AgentConfig = {
    apiKey,
    dataDir,
    domain,
    maxUploadSize,
    httpPort,
    httpsPort,
    email,
  }

  console.log(chalk.cyan("siteio-agent starting..."))
  console.log("")
  console.log(`  Domain: ${chalk.bold(domain)}`)
  console.log(`  Data dir: ${dataDir}`)
  console.log(`  Max upload: ${maxUploadSize / 1024 / 1024}MB`)
  console.log(`  HTTP port: ${httpPort}`)
  console.log(`  HTTPS port: ${httpsPort}`)
  console.log("")

  if (!process.env.SITEIO_API_KEY) {
    console.log(chalk.yellow("! No API key set, generated one:"))
  }
  console.log(`  API Key: ${chalk.bold(apiKey)}`)
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
