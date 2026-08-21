import * as p from "@clack/prompts"
import chalk from "chalk"
import { randomBytes } from "crypto"
import { AgentServer } from "../../lib/agent/server.ts"
import { formatError } from "../../utils/output.ts"
import { encodeToken } from "../../utils/token.ts"
import { loadAgentConfig, updateAgentConfig } from "../../config/agent.ts"
import type { AgentConfig, AcmeConfig, ChatConfig } from "../../types.ts"

// Assemble the AI site-chat config from env (wins) then persisted config. The
// feature is only attached when a credential is present, so an unconfigured
// agent transparently hides the chat surface. Token/key are never logged.
function buildChatConfig(
  env: NodeJS.ProcessEnv,
  persisted: { llmProvider?: string; llmModel?: string; llmOauthToken?: string; llmApiKey?: string }
): ChatConfig | undefined {
  const oauthToken = env.SITEIO_LLM_OAUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN || persisted.llmOauthToken
  const apiKey = env.SITEIO_LLM_API_KEY || persisted.llmApiKey
  if (!oauthToken && !apiKey) return undefined
  const timeoutMs = parseInt(env.SITEIO_CHAT_TIMEOUT_MS || "240000", 10)
  return {
    provider: env.SITEIO_LLM_PROVIDER || persisted.llmProvider || "anthropic",
    model: env.SITEIO_LLM_MODEL || persisted.llmModel,
    oauthToken,
    apiKey,
    // Sandbox on by default (safe on multi-tenant hosts); opt out only for
    // trusted single-tenant/dev via SITEIO_CHAT_SANDBOX=false.
    sandbox: !["false", "0", "no", "off"].includes((env.SITEIO_CHAT_SANDBOX || "").trim().toLowerCase()),
    sandboxImage: env.SITEIO_CHAT_SANDBOX_IMAGE || "siteio-chat-sandbox:latest",
    sandboxNetwork: env.SITEIO_CHAT_SANDBOX_NETWORK || "siteio-chat-net",
    maxTurns: parseInt(env.SITEIO_CHAT_MAX_TURNS || "40", 10),
    // Clamp to <255s so a turn can't outlive Bun's max SSE idle timeout.
    timeoutMs: Math.min(Math.max(timeoutMs, 30000), 240000),
  }
}

function generateApiKey(): string {
  return randomBytes(32).toString("hex")
}

// Interpret a persisted (boolean) or env/config-set (string) flag as a boolean.
// `agent config set` stores string values, so "false"/"0"/"no"/"off" must be
// recognised as disabled; anything unrecognised falls back to the default.
function parseBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback
  if (typeof value === "boolean") return value
  const v = String(value).trim().toLowerCase()
  if (["false", "0", "no", "off"].includes(v)) return false
  if (["true", "1", "yes", "on"].includes(v)) return true
  return fallback
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

  // Apps default to enabled; disable on hosts that should only allow sites.
  // Env var wins over persisted config; both fall back to enabled.
  const appsEnabled = parseBool(
    process.env.SITEIO_APPS_ENABLED ?? persistedConfig.appsEnabled,
    true
  )

  if (!email) {
    console.error(formatError("SITEIO_EMAIL environment variable is required for Let's Encrypt certificates"))
    console.error(chalk.gray("  Set it in your systemd service file or environment"))
    process.exit(1)
  }

  // Save config for persistence
  updateAgentConfig(dataDir, { apiKey, domain })

  // Build ACME config from persisted config
  let acme: AcmeConfig | undefined
  if (persistedConfig.acmeChallenge) {
    acme = {
      challenge: persistedConfig.acmeChallenge,
      dnsProvider: persistedConfig.acmeDnsProvider,
      dnsEnv: persistedConfig.acmeDnsEnv,
    }
  }

  const chat = buildChatConfig(process.env, persistedConfig)

  const config: AgentConfig = {
    apiKey,
    dataDir,
    domain,
    maxUploadSize,
    httpPort,
    httpsPort,
    email,
    acme,
    appsEnabled,
    chat,
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
  console.log(`  Apps:       ${appsEnabled ? "enabled" : "disabled"}`)
  console.log(
    `  Chat:       ${chat ? `enabled (${chat.provider}${chat.model ? "/" + chat.model : ""}, ${chat.sandbox ? "sandboxed" : "host"})` : "disabled (no LLM credential)"}`
  )
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
