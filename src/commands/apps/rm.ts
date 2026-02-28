import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { confirm } from "../../utils/prompt.ts"
import { resolveAppName } from "../../utils/site-config.ts"

export interface RemoveAppOptions {
  force?: boolean
  yes?: boolean
  json?: boolean
}

export async function rmAppCommand(
  name: string | undefined,
  options: RemoveAppOptions = {}
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

    const client = new SiteioClient()

    // If not forced, check if running and warn
    if (!options.force) {
      spinner.start(`Checking app status`)
      const app = await client.getApp(name)
      spinner.stop()

      if (app.status === "running") {
        console.error(chalk.yellow(`! App '${name}' is currently running.`))
        console.error(chalk.yellow(`  Use --force (-f) to remove a running app.`))
        process.exit(1)
      }
    }

    if (!options.yes) {
      const confirmed = await confirm(`Remove app ${chalk.bold(name)}?`)
      if (!confirmed) {
        console.error("Cancelled")
        process.exit(0)
      }
    }

    spinner.start(`Removing app ${name}`)
    await client.deleteApp(name)

    spinner.succeed(`Removed app ${name}`)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { name, deleted: true } }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`App ${chalk.bold(name)} has been removed.`))
      console.log("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
