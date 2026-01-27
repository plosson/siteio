import chalk from "chalk"
import { loadConfig } from "../config/loader.ts"
import { formatSuccess, formatError } from "../utils/output.ts"

export async function statusCommand(): Promise<void> {
  const config = loadConfig()

  console.log(chalk.cyan("siteio status"))
  console.log("")

  if (!config.apiUrl || !config.apiKey) {
    console.log(`  Connected: ${chalk.red("No")}`)
    console.log("")
    console.log(formatError("Not logged in"))
    console.log(chalk.gray("  Run 'siteio login -t <token>' to connect"))
    process.exit(1)
  }

  // Test connection
  let serverOk = false
  try {
    const response = await fetch(`${config.apiUrl}/health`, {
      headers: { "X-API-Key": config.apiKey },
    })
    serverOk = response.ok
  } catch {
    // Connection failed
  }

  console.log(`  Connected: ${chalk.green("Yes")}`)
  console.log(`  API URL:   ${config.apiUrl}`)
  console.log(`  Server:    ${serverOk ? chalk.green("reachable") : chalk.red("unreachable")}`)
  console.log("")

  if (serverOk) {
    console.log(formatSuccess("Connected and ready to deploy"))
  } else {
    console.log(formatError("Cannot reach server"))
    console.log(chalk.gray("  Check your network or server status"))
    process.exit(1)
  }
}
