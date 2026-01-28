import * as p from "@clack/prompts"
import chalk from "chalk"
import { randomBytes } from "crypto"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { loadOAuthConfig, saveOAuthConfig } from "../../config/oauth.ts"
import { formatSuccess, formatError } from "../../utils/output.ts"
import type { AgentOAuthConfig } from "../../types.ts"

function generateCookieSecret(): string {
  // oauth2-proxy requires exactly 16, 24, or 32 bytes
  // 16 bytes as hex = 32 characters
  return randomBytes(16).toString("hex")
}

export async function oauthAgentCommand(): Promise<void> {
  p.intro(chalk.bgCyan(" siteio agent oauth "))

  const dataDir = process.env.SITEIO_DATA_DIR || "/data"

  // Check if agent config exists to get the domain
  const agentConfigPath = join(dataDir, "agent-config.json")
  let domain = ""

  if (existsSync(agentConfigPath)) {
    try {
      const agentConfig = JSON.parse(readFileSync(agentConfigPath, "utf-8"))
      domain = agentConfig.domain || ""
    } catch {
      // Ignore errors
    }
  }

  if (!domain) {
    console.error(formatError("Agent not configured. Run 'siteio agent install' or 'siteio agent start' first."))
    process.exit(1)
  }

  // Check if OAuth is already configured
  const existingConfig = loadOAuthConfig(dataDir)
  if (existingConfig) {
    console.log(chalk.yellow("OAuth is already configured."))
    console.log("")
    const shouldReconfigure = await p.confirm({
      message: "Do you want to reconfigure it?",
      initialValue: false,
    })

    if (p.isCancel(shouldReconfigure) || !shouldReconfigure) {
      p.cancel("Configuration cancelled")
      process.exit(0)
    }
  }

  console.log("")
  console.log(chalk.cyan("Configure an OIDC provider (Auth0, Okta, Google, etc.)"))
  console.log("")
  console.log("  You'll need:")
  console.log("     - Issuer URL (e.g., https://your-tenant.auth0.com)")
  console.log("     - Client ID")
  console.log("     - Client Secret")
  console.log("")
  console.log(`  Callback URL: ${chalk.cyan(`https://api.${domain}/oauth2/callback`)}`)
  console.log("")

  const answers = await p.group(
    {
      issuerUrl: () =>
        p.text({
          message: "Issuer URL:",
          placeholder: "https://your-tenant.auth0.com",
          validate: (value) => {
            if (!value) return "Issuer URL is required"
            if (!value.startsWith("https://")) return "Issuer URL must start with https://"
          },
        }),
      clientId: () =>
        p.text({
          message: "Client ID:",
          validate: (value) => {
            if (!value) return "Client ID is required"
          },
        }),
      clientSecret: () =>
        p.password({
          message: "Client Secret:",
          validate: (value) => {
            if (!value) return "Client Secret is required"
          },
        }),
    },
    {
      onCancel: () => {
        p.cancel("Configuration cancelled")
        process.exit(0)
      },
    }
  )

  // Ensure issuer URL has trailing slash (required by some OIDC providers like Auth0)
  let issuerUrl = answers.issuerUrl as string
  if (!issuerUrl.endsWith("/")) {
    issuerUrl += "/"
  }

  const config: AgentOAuthConfig = {
    issuerUrl,
    clientId: answers.clientId as string,
    clientSecret: answers.clientSecret as string,
    cookieSecret: generateCookieSecret(),
    cookieDomain: domain,
  }

  const s = p.spinner()
  s.start("Saving OAuth configuration")

  try {
    saveOAuthConfig(dataDir, config)
    s.stop(chalk.green("Configuration saved"))

    console.log("")
    console.log(formatSuccess("Google OAuth configured successfully!"))
    console.log("")
    console.log(chalk.yellow("Important:"))
    console.log("  Restart the agent for changes to take effect:")
    console.log(chalk.gray("    siteio agent restart"))
    console.log("")
    console.log("  Or if running in foreground, stop and start again.")
    console.log("")

    p.outro(chalk.green("OAuth setup complete!"))
  } catch (err) {
    s.stop(chalk.red("Failed"))
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error(formatError(`Failed to save configuration: ${message}`))
    process.exit(1)
  }
}
