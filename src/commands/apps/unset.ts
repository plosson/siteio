import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { resolveAppName } from "../../utils/site-config.ts"

export interface UnsetAppOptions {
  env?: string[]
  json?: boolean
}

export async function unsetAppCommand(
  name: string | undefined,
  options: UnsetAppOptions = {}
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

    if (!options.env || options.env.length === 0) {
      throw new ValidationError("No keys specified. Use --env KEY to remove environment variables")
    }

    const client = new SiteioClient()

    spinner.start(`Updating app ${name}`)

    const app = await client.updateApp(name, { unsetEnv: options.env })

    spinner.succeed(`Updated app ${name}`)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: app }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`App ${chalk.bold(name)} updated.`))
      console.log("")
      console.log(chalk.bold("Environment variables removed:"))
      for (const key of options.env) {
        console.log(`  ${key}`)
      }
      console.log("")

      if (app.status === "running") {
        console.log(chalk.dim(`Restart the app for changes to take effect: siteio apps restart ${name}`))
        console.log("")
      }
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
