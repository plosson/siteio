#!/usr/bin/env bun

import { Command } from "commander"
import { getVersion } from "./lib/version.ts"

// Commander calls option parsers as fn(value, previous), so bare parseInt
// would receive the option's default/previous value as its radix.
function intArg(value: string): number {
  return parseInt(value, 10)
}

const program = new Command()
  .name("siteio")
  .description("Deploy static sites and apps with ease")
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
  .option("--username <name>", "Set username for deploy attribution (skips prompt)")
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

program
  .command("ui")
  .argument("[domain]", "Server domain to open (defaults to the current server)")
  .description("Open the web UI to manage sites and apps")
  .action(async (domain) => {
    const { uiCommand } = await import("./commands/ui.ts")
    await uiCommand(domain)
  })

// Sites commands. Every site ships with a PocketBase backend (auth, database,
// file storage) — using it is optional; a plain folder of HTML deploys as-is.
function registerSiteCommands(sites: Command): void {
  sites
    .command("init [folder]")
    .description("Scaffold a new site project (index.html + starter backend schema + AI guide)")
    .action(async (folder) => {
      const { sitesInitCommand } = await import("./commands/sites/init.ts")
      await sitesInitCommand(folder, { json: program.opts().json })
    })

  sites
    .command("dev [folder]")
    .description("Run the site locally with its backend (no Docker required)")
    .option("-p, --port <port>", "Local port", intArg, 8090)
    .action(async (folder, options) => {
      const { sitesDevCommand } = await import("./commands/sites/dev.ts")
      await sitesDevCommand(folder, options)
    })

  sites
    .command("deploy [folder]")
    .description("Deploy a folder as a site (frontend + backend)")
    .option("-n, --name <name>", "Site name (defaults to .siteio/config.json, then folder name)")
    .option("--test", "Deploy a simple test page (no folder required)")
    .option("--force", "Deploy even if there is a version conflict")
    .action(async (folder, options) => {
      const { sitesDeployCommand } = await import("./commands/sites/deploy.ts")
      await sitesDeployCommand(folder, { ...options, json: program.opts().json })
    })

  sites
    .command("list")
    .alias("ls")
    .description("List all deployed sites")
    .action(async () => {
      const { sitesListCommand } = await import("./commands/sites/list.ts")
      await sitesListCommand({ json: program.opts().json })
    })

  sites
    .command("info [name]")
    .description("Show detailed info about a site")
    .action(async (name) => {
      const { sitesInfoCommand } = await import("./commands/sites/info.ts")
      await sitesInfoCommand(name, { json: program.opts().json })
    })

  sites
    .command("download [output-folder]")
    .description("Download a deployed site's code to a local folder (defaults to ./<name>)")
    .option("-n, --name <name>", "Site to download (defaults to .siteio/config.json)")
    .option("-y, --yes", "Overwrite existing folder contents")
    .action(async (outputFolder, options) => {
      const { sitesDownloadCommand } = await import("./commands/sites/download.ts")
      await sitesDownloadCommand(outputFolder, { ...options, json: program.opts().json })
    })

  sites
    .command("logs [name]")
    .description("Show backend logs from a site")
    .option("-t, --tail <n>", "Number of lines", intArg, 100)
    .action(async (name, options) => {
      const { sitesLogsCommand } = await import("./commands/sites/logs.ts")
      await sitesLogsCommand(name, { ...options, json: program.opts().json })
    })

  sites
    .command("admin [name]")
    .description("Show the backend admin URL and superuser credentials")
    .action(async (name) => {
      const { sitesAdminCommand } = await import("./commands/sites/admin.ts")
      await sitesAdminCommand(name, { json: program.opts().json })
    })

  sites
    .command("history [name]")
    .description("Show code version history for a site")
    .action(async (name, options) => {
      const { sitesHistoryCommand } = await import("./commands/sites/history.ts")
      await sitesHistoryCommand(name, { json: program.opts().json })
    })

  sites
    .command("rollback [name]")
    .description("Rollback a site's code to a previous version (data is untouched)")
    .option("-v, --version <version>", "Version to rollback to")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (name, options) => {
      const { sitesRollbackCommand } = await import("./commands/sites/rollback.ts")
      await sitesRollbackCommand(name, options.version, { ...options, json: program.opts().json })
    })

  sites
    .command("rename <new-name>")
    .description("Rename a site (changes its subdomain)")
    .option("-n, --name <name>", "Site to rename (defaults to .siteio/config.json)")
    .action(async (newName, options) => {
      const { sitesRenameCommand } = await import("./commands/sites/rename.ts")
      await sitesRenameCommand(options.name, newName, { json: program.opts().json })
    })

  sites
    .command("rm [name]")
    .description("Remove a deployed site and its data")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (name, options) => {
      const { sitesRmCommand } = await import("./commands/sites/rm.ts")
      await sitesRmCommand(name, { ...options, json: program.opts().json })
    })

  const siteShare = sites
    .command("share")
    .description("Grant and manage revocable access for others to edit a site")

  // Bare `siteio sites share [name]` mints a link (the common case). The
  // list/revoke subcommands hang off the same group.
  siteShare
    .argument("[name]", "Site to share (defaults to .siteio/config.json)")
    .option("--label <label>", "Attribution label shown in the site's deploy history")
    .option("--allow-backend", "Let the invitee also change backend code (pb_migrations, pb_hooks) — can affect live data")
    .action(async (name, options) => {
      const { sitesShareCommand } = await import("./commands/sites/share.ts")
      await sitesShareCommand(name, { ...options, json: program.opts().json })
    })

  siteShare
    .command("list [name]")
    .alias("ls")
    .description("List active share links for a site")
    .action(async (name, options) => {
      const { sitesShareListCommand } = await import("./commands/sites/share.ts")
      await sitesShareListCommand(name, { ...options, json: program.opts().json })
    })

  siteShare
    .command("revoke <id>")
    .description("Revoke a share link by id")
    .option("-n, --name <name>", "Site the link belongs to (defaults to .siteio/config.json)")
    .action(async (id, options) => {
      const { sitesShareRevokeCommand } = await import("./commands/sites/share.ts")
      await sitesShareRevokeCommand(id, { ...options, json: program.opts().json })
    })

  const siteDomain = sites
    .command("domain")
    .description("Manage custom domains for a site")

  siteDomain
    .command("add <domain>")
    .description("Add a custom domain to a site")
    .option("-n, --name <name>", "Site to add domain to (defaults to .siteio/config.json)")
    .action(async (domain, options) => {
      const { domainAddCommand } = await import("./commands/sites/domain.ts")
      await domainAddCommand(domain, { ...options, json: program.opts().json })
    })

  siteDomain
    .command("remove <domain>")
    .description("Remove a custom domain from a site")
    .option("-n, --name <name>", "Site to remove domain from (defaults to .siteio/config.json)")
    .action(async (domain, options) => {
      const { domainRemoveCommand } = await import("./commands/sites/domain.ts")
      await domainRemoveCommand(domain, { ...options, json: program.opts().json })
    })

  siteDomain
    .command("list")
    .alias("ls")
    .description("List custom domains for a site")
    .option("-n, --name <name>", "Site to list domains for (defaults to .siteio/config.json)")
    .action(async (options) => {
      const { domainListCommand } = await import("./commands/sites/domain.ts")
      await domainListCommand({ ...options, json: program.opts().json })
    })
}

registerSiteCommands(
  program
    .command("sites")
    .description("Manage deployed sites (static frontend + built-in backend)")
)

// Hidden transition alias: existing projects and scripts still say `siteio pocket`.
const pocketAlias = new Command("pocket")
  .description("Deprecated alias for 'sites'")
registerSiteCommands(pocketAlias)
program.addCommand(pocketAlias, { hidden: true })

// Apps commands
const apps = program
  .command("apps")
  .description("Manage containerized applications")

apps
  .command("init [folder]")
  .description("Scaffold a new app project (Dockerfile + AI guide)")
  .action(async (folder) => {
    const { appsInitCommand } = await import("./commands/apps/init.ts")
    await appsInitCommand(folder, { json: program.opts().json })
  })

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
  .option("--env-file <path>", "Path to a local .env file to upload alongside the compose file")
  .option("--branch <branch>", "Git branch (default: main)")
  .option("--context <path>", "Build context subdirectory for monorepos")
  .option("--git-token <token>", "Personal access token for cloning a private HTTPS git repo")
  .option("-p, --port <port>", "Internal port the container listens on", intArg)
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
  .option("-t, --tail <n>", "Number of lines to show", intArg, 100)
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
  .option("-p, --port <port>", "Set internal port", intArg)
  .option("-r, --restart <policy>", "Set restart policy (always, unless-stopped, on-failure, no)")
  .option("--image <image>", "Set Docker image")
  .option("--dockerfile <path>", "Set Dockerfile path (git-based apps only)")
  .option("--git-token <token>", "Update the token used to clone a private HTTPS git repo (pass empty string to clear)")
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
  .option("-s, --scope <scope>", "Install scope: user (~/.claude) or project (./.claude)")
  .action(async (options) => {
    const { installSkillCommand } = await import("./commands/skill.ts")
    await installSkillCommand({ json: program.opts().json, scope: options.scope })
  })

skill
  .command("uninstall")
  .description("Remove the siteio skill from Claude Code")
  .option("-s, --scope <scope>", "Uninstall scope: user (~/.claude) or project (./.claude)")
  .action(async (options) => {
    const { uninstallSkillCommand } = await import("./commands/skill.ts")
    await uninstallSkillCommand({ json: program.opts().json, scope: options.scope })
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
