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
  .option("--json", "Output results as JSON")

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
    await deployCommand(folder, { ...options, json: program.opts().json })
  })

sites
  .command("list")
  .alias("ls")
  .description("List all deployed sites")
  .action(async () => {
    const { listCommand } = await import("./commands/sites/list.ts")
    await listCommand({ json: program.opts().json })
  })

sites
  .command("info <subdomain>")
  .description("Show detailed info about a site")
  .action(async (subdomain) => {
    const { infoCommand } = await import("./commands/sites/info.ts")
    await infoCommand(subdomain, { json: program.opts().json })
  })

sites
  .command("download <subdomain> <output-folder>")
  .description("Download a deployed site to a local folder")
  .action(async (subdomain, outputFolder) => {
    const { downloadCommand } = await import("./commands/sites/download.ts")
    await downloadCommand(subdomain, outputFolder, { json: program.opts().json })
  })

sites
  .command("undeploy <subdomain>")
  .description("Remove a deployed site")
  .action(async (subdomain) => {
    const { undeployCommand } = await import("./commands/sites/undeploy.ts")
    await undeployCommand(subdomain, { json: program.opts().json })
  })

sites
  .command("auth <subdomain>")
  .description("Set or remove Google OAuth for a site")
  .option("--allowed-emails <emails>", "Comma-separated list of allowed email addresses (replaces existing)")
  .option("--allowed-domain <domain>", "Allow all emails from this domain (replaces existing)")
  .option("--allowed-groups <groups>", "Comma-separated list of allowed groups (replaces existing)")
  .option("--add-email <email>", "Add email(s) to allowed list")
  .option("--remove-email <email>", "Remove email(s) from allowed list")
  .option("--add-domain <domain>", "Set allowed domain")
  .option("--remove-domain <domain>", "Remove allowed domain")
  .option("--add-group <group>", "Add group(s) to allowed list")
  .option("--remove-group <group>", "Remove group(s) from allowed list")
  .option("--remove", "Remove all authentication")
  .action(async (subdomain, options) => {
    const { authCommand } = await import("./commands/sites/auth.ts")
    await authCommand(subdomain, { ...options, json: program.opts().json })
  })

// Groups command
const groups = program
  .command("groups")
  .description("Manage email groups for access control")

groups
  .command("list")
  .alias("ls")
  .description("List all groups")
  .action(async () => {
    const { listGroupsCommand } = await import("./commands/groups.ts")
    await listGroupsCommand({ json: program.opts().json })
  })

groups
  .command("show <name>")
  .description("Show group details")
  .action(async (name) => {
    const { showGroupCommand } = await import("./commands/groups.ts")
    await showGroupCommand(name, { json: program.opts().json })
  })

groups
  .command("create <name>")
  .description("Create a new group")
  .option("--emails <emails>", "Comma-separated list of email addresses")
  .action(async (name, options) => {
    const { createGroupCommand } = await import("./commands/groups.ts")
    await createGroupCommand(name, { ...options, json: program.opts().json })
  })

groups
  .command("delete <name>")
  .description("Delete a group")
  .action(async (name) => {
    const { deleteGroupCommand } = await import("./commands/groups.ts")
    await deleteGroupCommand(name, { json: program.opts().json })
  })

groups
  .command("add <name>")
  .description("Add emails to a group")
  .option("--email <emails>", "Comma-separated list of email addresses to add")
  .action(async (name, options) => {
    const { addToGroupCommand } = await import("./commands/groups.ts")
    await addToGroupCommand(name, { ...options, json: program.opts().json })
  })

groups
  .command("remove <name>")
  .description("Remove emails from a group")
  .option("--email <emails>", "Comma-separated list of email addresses to remove")
  .action(async (name, options) => {
    const { removeFromGroupCommand } = await import("./commands/groups.ts")
    await removeFromGroupCommand(name, { ...options, json: program.opts().json })
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

// Skill commands
const skill = program
  .command("skill")
  .description("Manage Claude Code skill integration")

skill
  .command("install")
  .description("Install the siteio skill for Claude Code")
  .action(async () => {
    const { installSkillCommand } = await import("./commands/skill.ts")
    await installSkillCommand({ json: program.opts().json })
  })

skill
  .command("uninstall")
  .description("Remove the siteio skill from Claude Code")
  .action(async () => {
    const { uninstallSkillCommand } = await import("./commands/skill.ts")
    await uninstallSkillCommand({ json: program.opts().json })
  })

program.parse()
