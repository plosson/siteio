import * as p from "@clack/prompts"
import chalk from "chalk"
import { randomBytes } from "crypto"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { loadOAuthConfig, saveOAuthConfig } from "../../config/oauth.ts"
import { formatSuccess, formatError } from "../../utils/output.ts"
import type { AgentOAuthConfig } from "../../types.ts"

function generateCookieSecret(): string {
  return randomBytes(32).toString("base64")
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
  console.log(chalk.cyan("To set up Google OAuth via Clerk:"))
  console.log("")
  console.log("  1. Go to https://clerk.com and create a new application")
  console.log("  2. Enable Google as a social connection")
  console.log("  3. Copy your API keys from the Clerk dashboard")
  console.log("")

  const answers = await p.group(
    {
      clerkPublishableKey: () =>
        p.text({
          message: "Clerk Publishable Key:",
          placeholder: "pk_live_...",
          validate: (value) => {
            if (!value) return "Publishable key is required"
            if (!value.startsWith("pk_")) return "Invalid publishable key format"
          },
        }),
      clerkSecretKey: () =>
        p.password({
          message: "Clerk Secret Key:",
          validate: (value) => {
            if (!value) return "Secret key is required"
            if (!value.startsWith("sk_")) return "Invalid secret key format"
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

  const config: AgentOAuthConfig = {
    clerkPublishableKey: answers.clerkPublishableKey as string,
    clerkSecretKey: answers.clerkSecretKey as string,
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
