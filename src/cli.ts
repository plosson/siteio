#!/usr/bin/env bun

import { Command } from "commander"
import { readFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

// BUILD_VERSION is injected at compile time via --define
declare const BUILD_VERSION: string | undefined

const __dirname = dirname(fileURLToPath(import.meta.url))

function getVersion(): string {
  // Use build-time version if available (compiled binary)
  if (typeof BUILD_VERSION !== "undefined") {
    return BUILD_VERSION
  }
  // Fall back to package.json (development)
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"))
    return pkg.version
  } catch {
    return "0.0.0"
  }
}

const program = new Command()
  .name("siteio")
  .description("Deploy static sites with ease")
  .version(getVersion())

// Status command
program
  .command("status")
  .description("Show connection status")
  .action(async () => {
    const { statusCommand } = await import("./commands/status.ts")
    await statusCommand()
  })

// Login command
program
  .command("login")
  .description("Configure API credentials")
  .option("--api-url <url>", "API URL")
  .option("--api-key <key>", "API key")
  .option("-t, --token <token>", "Connection token (contains URL and API key)")
  .action(async (options) => {
    const { loginCommand } = await import("./commands/login.ts")
    await loginCommand(options)
  })

// Sites commands
const sites = program
  .command("sites")
  .description("Manage deployed sites")

sites
  .command("deploy [folder]")
  .description("Deploy a folder as a static site")
  .option("-s, --subdomain <name>", "Subdomain to deploy to (defaults to folder name)")
  .option("--allowed-emails <emails>", "Comma-separated list of allowed email addresses for Google OAuth")
  .option("--allowed-domain <domain>", "Allow all emails from this domain for Google OAuth")
  .option("--test", "Deploy a simple test page (no folder required)")
  .action(async (folder, options) => {
    const { deployCommand } = await import("./commands/sites/deploy.ts")
    await deployCommand(folder, options)
  })

sites
  .command("list")
  .description("List all deployed sites")
  .action(async () => {
    const { listCommand } = await import("./commands/sites/list.ts")
    await listCommand()
  })

sites
  .command("undeploy <subdomain>")
  .description("Remove a deployed site")
  .action(async (subdomain) => {
    const { undeployCommand } = await import("./commands/sites/undeploy.ts")
    await undeployCommand(subdomain)
  })

sites
  .command("auth <subdomain>")
  .description("Set or remove Google OAuth for a site")
  .option("--allowed-emails <emails>", "Comma-separated list of allowed email addresses")
  .option("--allowed-domain <domain>", "Allow all emails from this domain")
  .option("--remove", "Remove authentication")
  .action(async (subdomain, options) => {
    const { authCommand } = await import("./commands/sites/auth.ts")
    await authCommand(subdomain, options)
  })

// Agent command (for running the server)
const agent = program
  .command("agent")
  .description("Run the siteio agent server")

agent
  .command("install")
  .description("Install and start the agent as a systemd service")
  .action(async () => {
    const { installAgentCommand } = await import("./commands/agent/install.ts")
    await installAgentCommand()
  })

agent
  .command("oauth")
  .description("Configure OIDC authentication (Auth0, Okta, etc.)")
  .action(async () => {
    const { oauthAgentCommand } = await import("./commands/agent/oauth.ts")
    await oauthAgentCommand()
  })

agent
  .command("start")
  .description("Start the agent server (foreground or via systemd)")
  .action(async () => {
    const { startAgentCommand } = await import("./commands/agent/start.ts")
    await startAgentCommand()
  })

agent
  .command("stop")
  .description("Stop the agent server")
  .action(async () => {
    const { stopAgentCommand } = await import("./commands/agent/stop.ts")
    await stopAgentCommand()
  })

agent
  .command("restart")
  .description("Restart the agent server")
  .action(async () => {
    const { restartAgentCommand } = await import("./commands/agent/restart.ts")
    await restartAgentCommand()
  })

agent
  .command("status")
  .description("Check agent server status")
  .action(async () => {
    const { statusAgentCommand } = await import("./commands/agent/status.ts")
    await statusAgentCommand()
  })

// Update command
program
  .command("update")
  .description("Update siteio to the latest version")
  .option("--check", "Only check for updates, don't install")
  .option("--force", "Force update even if already on latest version")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (options) => {
    const { updateCommand } = await import("./commands/update.ts")
    await updateCommand(options)
  })

program.parse()
