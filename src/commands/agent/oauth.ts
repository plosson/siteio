import * as p from "@clack/prompts"
import chalk from "chalk"
import { randomBytes } from "crypto"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { loadOAuthConfig, saveOAuthConfig } from "../../config/oauth.ts"
import { discoverOIDC } from "../../config/oidc-discovery.ts"
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

  const provider = await p.select({
    message: "Which OAuth provider do you want to use?",
    options: [
      { value: "google", label: "Google", hint: "Sign in with a Google account" },
      { value: "auth0", label: "Auth0", hint: "Use an Auth0 tenant" },
      { value: "other", label: "Other", hint: "Any OIDC-compatible provider" },
    ],
  })
  if (p.isCancel(provider)) {
    p.cancel("Configuration cancelled")
    process.exit(0)
  }

  let issuerUrl: string
  if (provider === "google") {
    issuerUrl = "https://accounts.google.com"
  } else if (provider === "auth0") {
    const tenant = await p.text({
      message: "Auth0 tenant domain:",
      placeholder: "your-tenant.eu.auth0.com",
      validate: (value) => {
        if (!value) return "Tenant domain is required"
        if (value.startsWith("http")) return "Just the domain, without https://"
      },
    })
    if (p.isCancel(tenant)) {
      p.cancel("Configuration cancelled")
      process.exit(0)
    }
    issuerUrl = `https://${tenant}`
  } else {
    const url = await p.text({
      message: "OIDC Issuer URL:",
      placeholder: "https://your-provider.example.com",
      validate: (value) => {
        if (!value) return "Issuer URL is required"
        if (!value.startsWith("https://")) return "Issuer URL must start with https://"
      },
    })
    if (p.isCancel(url)) {
      p.cancel("Configuration cancelled")
      process.exit(0)
    }
    issuerUrl = url as string
  }

  console.log("")
  console.log(chalk.cyan("Register this callback URL in your provider:"))
  console.log(chalk.cyan(`  https://auth.${domain}/oauth2/callback`))
  console.log("")

  const creds = await p.group(
    {
      clientId: () =>
        p.text({
          message: "Client ID:",
          validate: (v) => (!v ? "Client ID is required" : undefined),
        }),
      clientSecret: () =>
        p.password({
          message: "Client Secret:",
          validate: (v) => (!v ? "Client Secret is required" : undefined),
        }),
    },
    {
      onCancel: () => {
        p.cancel("Configuration cancelled")
        process.exit(0)
      },
    }
  )

  const s = p.spinner()
  s.start("Verifying provider & saving configuration")

  try {
    const discovered = await discoverOIDC(issuerUrl)

    const config: AgentOAuthConfig = {
      issuerUrl: discovered.issuer,
      clientId: creds.clientId as string,
      clientSecret: creds.clientSecret as string,
      cookieSecret: generateCookieSecret(),
      cookieDomain: domain,
      endSessionEndpoint: discovered.endSessionEndpoint,
      discoveredAt: new Date().toISOString(),
    }
    saveOAuthConfig(dataDir, config)
    s.stop(chalk.green("Configuration saved"))

    console.log("")
    console.log(formatSuccess("OAuth configured successfully!"))
    console.log("")
    console.log(chalk.yellow("Important:"))
    console.log("  Restart the agent for changes to take effect:")
    console.log(chalk.gray("    siteio agent restart"))
    console.log("")

    p.outro(chalk.green("OAuth setup complete!"))
  } catch (err) {
    s.stop(chalk.red("Failed"))
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error(formatError(`Failed to configure OAuth: ${message}`))
    process.exit(1)
  }
}
