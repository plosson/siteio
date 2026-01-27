#!/usr/bin/env bun

import { Command } from "commander"
import { readFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

function getVersion(): string {
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
  .command("deploy <folder>")
  .description("Deploy a folder as a static site")
  .option("-s, --subdomain <name>", "Subdomain to deploy to (defaults to folder name)")
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

// Agent command (for running the server)
const agent = program
  .command("agent")
  .description("Run the siteio agent server")

agent
  .command("start")
  .description("Start the agent server")
  .action(async () => {
    const { startAgentCommand } = await import("./commands/agent/start.ts")
    await startAgentCommand()
  })

program.parse()
