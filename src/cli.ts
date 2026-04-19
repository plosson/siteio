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

// Config command (client-side settings)
const config = program
  .command("config")
  .description("Manage client configuration")

config
  .command("set <key> <value>")
  .description("Set a config value (e.g., username)")
  .action(async (key, value) => {
    const { configSetCommand } = await import("./commands/config.ts")
    await configSetCommand(key, value, { json: program.opts().json })
  })

config
  .command("get <key>")
  .description("Get a config value")
  .action(async (key) => {
    const { configGetCommand } = await import("./commands/config.ts")
    await configGetCommand(key, { json: program.opts().json })
  })

// Login command
program
  .command("login")
  .argument("[domain]", "Switch to existing server by domain")
  .description("Configure API credentials or switch servers")
  .option("--api-url <url>", "API URL")
  .option("--api-key <key>", "API key")
  .option("-t, --token <token>", "Connection token (contains URL and API key)")
  .action(async (domain, options) => {
    const { loginCommand } = await import("./commands/login.ts")
    await loginCommand({ ...options, domain })
  })

// Logout command
program
  .command("logout")
  .argument("[domain]", "Server domain to remove")
  .description("Remove a saved server")
  .action(async (domain) => {
    const { logoutCommand } = await import("./commands/logout.ts")
    await logoutCommand(domain)
  })

// Sites commands
const sites = program
  .command("sites")
  .description("Manage deployed sites")

sites
  .command("deploy [folder]")
  .description("Deploy a folder as a static site")
  .option("-s, --subdomain <subdomain>", "Subdomain to deploy to (defaults to folder name)")
  .option("--allowed-emails <emails>", "Comma-separated list of allowed email addresses for Google OAuth")
  .option("--allowed-domain <domain>", "Allow all emails from this domain for Google OAuth")
  .option("--test", "Deploy a simple test page (no folder required)")
  .option("--persistent-storage", "Enable persistent localStorage for this site")
  .option("--force", "Deploy even if there is a version conflict")
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
  .command("info")
  .description("Show detailed info about a site")
  .option("-s, --subdomain <subdomain>", "Site to show info for (defaults to .siteio/config.json)")
  .action(async (options) => {
    const { infoCommand } = await import("./commands/sites/info.ts")
    await infoCommand(options.subdomain, { json: program.opts().json })
  })

sites
  .command("download [output-folder]")
  .description("Download a deployed site to a local folder")
  .option("-s, --subdomain <subdomain>", "Site to download (defaults to .siteio/config.json)")
  .option("-y, --yes", "Overwrite existing folder contents")
  .action(async (outputFolder, options) => {
    const { downloadCommand } = await import("./commands/sites/download.ts")
    await downloadCommand(outputFolder ?? ".", { ...options, json: program.opts().json })
  })

sites
  .command("rm")
  .description("Remove a deployed site")
  .option("-s, --subdomain <subdomain>", "Site to remove (defaults to .siteio/config.json)")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (options) => {
    const { rmCommand } = await import("./commands/sites/rm.ts")
    await rmCommand(options.subdomain, { ...options, json: program.opts().json })
  })

sites
  .command("history")
  .description("Show version history for a site")
  .option("-s, --subdomain <subdomain>", "Site to show history for (defaults to .siteio/config.json)")
  .action(async (options) => {
    const { historyCommand } = await import("./commands/sites/history.ts")
    await historyCommand(options.subdomain, { json: program.opts().json })
  })

sites
  .command("rollback")
  .description("Rollback a site to a previous version")
  .option("-s, --subdomain <subdomain>", "Site to rollback (defaults to .siteio/config.json)")
  .option("-v, --version <version>", "Version to rollback to")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (options) => {
    const { rollbackCommand } = await import("./commands/sites/rollback.ts")
    await rollbackCommand(options.subdomain, options.version, { ...options, json: program.opts().json })
  })

sites
  .command("auth")
  .description("Set or remove Google OAuth for a site")
  .option("-s, --subdomain <subdomain>", "Site to configure auth for (defaults to .siteio/config.json)")
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
  .action(async (options) => {
    const { authCommand } = await import("./commands/sites/auth.ts")
    await authCommand(options.subdomain, { ...options, json: program.opts().json })
  })

sites
  .command("rename")
  .description("Rename a site (changes its subdomain)")
  .option("-s, --subdomain <subdomain>", "Site to rename (defaults to .siteio/config.json)")
  .requiredOption("--to <new-subdomain>", "New subdomain name")
  .action(async (options) => {
    const { renameCommand } = await import("./commands/sites/rename.ts")
    await renameCommand(options.subdomain, options.to, { json: program.opts().json })
  })

// Domain subcommands
const siteDomain = sites
  .command("domain")
  .description("Manage custom domains for a site")

siteDomain
  .command("add <domain>")
  .description("Add a custom domain to a site")
  .option("-s, --subdomain <subdomain>", "Site to add domain to (defaults to .siteio/config.json)")
  .action(async (domain, options) => {
    const { domainAddCommand } = await import("./commands/sites/domain.ts")
    await domainAddCommand(domain, { ...options, json: program.opts().json })
  })

siteDomain
  .command("remove <domain>")
  .description("Remove a custom domain from a site")
  .option("-s, --subdomain <subdomain>", "Site to remove domain from (defaults to .siteio/config.json)")
  .action(async (domain, options) => {
    const { domainRemoveCommand } = await import("./commands/sites/domain.ts")
    await domainRemoveCommand(domain, { ...options, json: program.opts().json })
  })

siteDomain
  .command("list")
  .alias("ls")
  .description("List custom domains for a site")
  .option("-s, --subdomain <subdomain>", "Site to list domains for (defaults to .siteio/config.json)")
  .action(async (options) => {
    const { domainListCommand } = await import("./commands/sites/domain.ts")
    await domainListCommand({ ...options, json: program.opts().json })
  })

sites
  .command("set")
  .description("Update site configuration")
  .option("-s, --subdomain <subdomain>", "Site to update (defaults to .siteio/config.json)")
  .option("-d, --domain <domain>", "Set custom domains, e.g. -d example.com -d www.example.com (repeatable)", (val: string, prev: string[]) => {
    prev = prev || []
    prev.push(val)
    return prev
  }, [])
  .option("--persistent-storage", "Enable persistent localStorage")
  .option("--no-persistent-storage", "Disable persistent localStorage")
  .action(async (options) => {
    const { setSiteCommand } = await import("./commands/sites/set.ts")
    await setSiteCommand(options.subdomain, { ...options, json: program.opts().json })
  })

// Apps commands
const apps = program
  .command("apps")
  .description("Manage containerized applications")

apps
  .command("create <name>")
  .description("Create a new app")
  .option("-i, --image <image>", "Docker image to use")
  .option("-g, --git <url>", "Git repository URL to build from")
  .option("-f, --file <path>", "Path to a self-contained Dockerfile (built remotely with empty context)")
  .option("--dockerfile <path>", "Path to Dockerfile inside the git repo (default: Dockerfile)")
  .option("--compose-file <path>", "Path to a local docker-compose.yml to upload")
  .option("--compose <path>", "Path to docker-compose.yml inside the git repo")
  .option("--service <name>", "Primary compose service to expose publicly")
  .option("--branch <branch>", "Git branch (default: main)")
  .option("--context <path>", "Build context subdirectory for monorepos")
  .option("-p, --port <port>", "Internal port the container listens on", parseInt)
  .action(async (name, options) => {
    const { createAppCommand } = await import("./commands/apps/create.ts")
    await createAppCommand(name, { ...options, json: program.opts().json })
  })

apps
  .command("list")
  .alias("ls")
  .description("List all apps")
  .action(async () => {
    const { listAppsCommand } = await import("./commands/apps/list.ts")
    await listAppsCommand({ json: program.opts().json })
  })

apps
  .command("info [name]")
  .description("Show detailed info about an app")
  .action(async (name) => {
    const { infoAppCommand } = await import("./commands/apps/info.ts")
    await infoAppCommand(name, { json: program.opts().json })
  })

apps
  .command("deploy [name]")
  .description("Deploy (start) an app container")
  .option("--no-cache", "Build without Docker cache (git or dockerfile apps only)")
  .option("-f, --file <path>", "Replace the stored Dockerfile and rebuild (inline-dockerfile apps only)")
  .action(async (name, options) => {
    const { deployAppCommand } = await import("./commands/apps/deploy.ts")
    // Commander's `--no-cache` flag sets `options.cache = false` (boolean
    // negation convention), NOT `options.noCache = true`. Translate to
    // the explicit `noCache` key the downstream command expects, otherwise
    // the flag is silently dropped on the wire (no `?noCache=true` query
    // param reaches the agent).
    const noCache = options.cache === false
    await deployAppCommand(name, { ...options, noCache, json: program.opts().json })
  })

apps
  .command("stop [name]")
  .description("Stop an app container")
  .action(async (name) => {
    const { stopAppCommand } = await import("./commands/apps/stop.ts")
    await stopAppCommand(name, { json: program.opts().json })
  })

apps
  .command("restart [name]")
  .description("Restart an app container")
  .action(async (name) => {
    const { restartAppCommand } = await import("./commands/apps/restart.ts")
    await restartAppCommand(name, { json: program.opts().json })
  })

apps
  .command("rm [name]")
  .description("Remove an app")
  .option("-f, --force", "Force remove even if running")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (name, options) => {
    const { rmAppCommand } = await import("./commands/apps/rm.ts")
    await rmAppCommand(name, { ...options, json: program.opts().json })
  })

apps
  .command("logs [name]")
  .description("Tail logs from an app container")
  .option("-t, --tail <n>", "Number of lines to show", parseInt, 100)
  .option("--service <name>", "Target a specific compose service (compose apps only)")
  .option("--all", "Show logs for all compose services (compose apps only)")
  .action(async (name, options) => {
    const { logsAppCommand } = await import("./commands/apps/logs.ts")
    await logsAppCommand(name, { ...options, json: program.opts().json })
  })

apps
  .command("set [name]")
  .description("Update app configuration")
  .option("-e, --env <KEY=value>", "Set environment variables (repeatable)", (val: string, prev: string[]) => {
    prev = prev || []
    prev.push(val)
    return prev
  }, [])
  .option("-v, --volume <name:path>", "Set volume mounts (repeatable)", (val: string, prev: string[]) => {
    prev = prev || []
    prev.push(val)
    return prev
  }, [])
  .option("-d, --domain <domain>", "Set custom domains (repeatable)", (val: string, prev: string[]) => {
    prev = prev || []
    prev.push(val)
    return prev
  }, [])
  .option("-p, --port <port>", "Set internal port", parseInt)
  .option("-r, --restart <policy>", "Set restart policy (always, unless-stopped, on-failure, no)")
  .option("--image <image>", "Set Docker image")
  .option("--dockerfile <path>", "Set Dockerfile path (git-based apps only)")
  .action(async (name, options) => {
    const { setAppCommand } = await import("./commands/apps/set.ts")
    await setAppCommand(name, { ...options, json: program.opts().json })
  })

apps
  .command("unset [name]")
  .description("Remove app configuration values")
  .option("-e, --env <KEY>", "Remove environment variables (repeatable)", (val: string, prev: string[]) => {
    prev = prev || []
    prev.push(val)
    return prev
  }, [])
  .action(async (name, options) => {
    const { unsetAppCommand } = await import("./commands/apps/unset.ts")
    await unsetAppCommand(name, { ...options, json: program.opts().json })
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
  .command("install [target]")
  .description("Install and start the agent locally, or on a remote server via user@host (auto-configures with sslip.io if no domain provided)")
  .option("--domain <domain>", "Domain for this agent (default: auto-detected sslip.io)")
  .option("--data-dir <path>", "Data directory (default: /data)")
  .option("--email <email>", "Email for Let's Encrypt")
  .option("--cloudflare-token <token>", "Cloudflare API token for automatic DNS setup")
  .option("-i, --identity <keyfile>", "SSH identity file for remote install")
  .action(async (target, options) => {
    const { installAgentCommand } = await import("./commands/agent/install.ts")
    await installAgentCommand(target, options)
  })

agent
  .command("uninstall [target]")
  .description("Uninstall the agent locally, or on a remote server via user@host")
  .option("-i, --identity <keyfile>", "SSH identity file for remote uninstall")
  .option("--remove-containers", "Also remove Docker containers (apps and Traefik)")
  .option("--remove-data", "Also remove data directory")
  .option("--remove-cloudflare", "Also remove Cloudflare DNS record")
  .option("-y, --yes", "Skip confirmation prompts")
  .action(async (target, options) => {
    const { uninstallAgentCommand } = await import("./commands/agent/uninstall.ts")
    await uninstallAgentCommand(target, options)
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

// Agent config subcommands
const agentConfig = agent
  .command("config")
  .description("Manage agent configuration")

agentConfig
  .command("list")
  .alias("ls")
  .description("List all configuration values")
  .action(async () => {
    const { listConfigCommand } = await import("./commands/agent/config.ts")
    await listConfigCommand({ json: program.opts().json })
  })

agentConfig
  .command("get <key>")
  .description("Get a configuration value")
  .action(async (key) => {
    const { getConfigCommand } = await import("./commands/agent/config.ts")
    await getConfigCommand(key, { json: program.opts().json })
  })

agentConfig
  .command("set <key> <value>")
  .description("Set a configuration value")
  .action(async (key, value) => {
    const { setConfigCommand } = await import("./commands/agent/config.ts")
    await setConfigCommand(key, value, { json: program.opts().json })
  })

agentConfig
  .command("unset <key>")
  .description("Remove a configuration value")
  .action(async (key) => {
    const { unsetConfigCommand } = await import("./commands/agent/config.ts")
    await unsetConfigCommand(key, { json: program.opts().json })
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

// Completion command
program
  .command("completion [shell]")
  .description("Set up shell completion (interactive) or output script (bash, zsh, fish)")
  .addHelpText("after", `
Examples:

  Interactive setup (recommended):
    siteio completion

  Manual setup:
    Bash: source <(siteio completion bash)
    Zsh:  source <(siteio completion zsh)
    Fish: siteio completion fish > ~/.config/fish/completions/siteio.fish
`)
  .action(async (shell) => {
    const { completionCommand } = await import("./commands/completion.ts")
    await completionCommand(shell)
  })

program.parse()
