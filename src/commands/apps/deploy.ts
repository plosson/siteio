import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { resolveAppName, saveProjectConfig } from "../../utils/site-config.ts"

export interface DeployAppOptions {
  noCache?: boolean
  json?: boolean
}

export async function deployAppCommand(
  name: string | undefined,
  options: DeployAppOptions = {}
): Promise<void> {
  const spinner = ora()

  try {
    const server = getCurrentServer()
    const resolved = resolveAppName(name, server?.domain ?? "")
    if (!resolved) {
      throw new ValidationError("App name required. Provide as argument or run from a directory with .siteio/config.json")
    }
    if (!name) {
      console.error(chalk.dim(`Using app '${resolved}' from .siteio/config.json`))
    }
    name = resolved

    const action = options.noCache ? "Building (no cache) and deploying" : "Deploying"
    spinner.start(`${action} app ${name}`)

    const client = new SiteioClient()
    const app = await client.deployApp(name, { noCache: options.noCache })

    spinner.succeed(`Deployed app ${name}`)

    // Save config so future commands don't need the app name
    if (server) {
      saveProjectConfig({ app: name, domain: server.domain })
    }

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: app }, null, 2))
    } else {
      const statusColor = app.status === "running" ? chalk.green : chalk.yellow

      console.log("")
      console.log(formatSuccess(`App ${chalk.bold(name)} deployed successfully!`))
      console.log("")
      console.log(`  Status: ${statusColor(app.status)}`)
      if (app.domains.length > 0) {
        console.log(`  URL:    ${chalk.cyan(`https://${app.domains[0]}`)}`)
      }
      console.log("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
