import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { resolveAppName } from "../../utils/site-config.ts"

export interface LogsAppOptions {
  tail?: number
  json?: boolean
}

export async function logsAppCommand(
  name: string | undefined,
  options: LogsAppOptions = {}
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

    const tail = options.tail || 100

    spinner.start(`Fetching logs for ${name}`)

    const client = new SiteioClient()
    const logs = await client.getAppLogs(name, tail)

    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: logs }, null, 2))
    } else {
      console.log(chalk.dim(`Showing last ${logs.lines} lines for ${logs.name}:`))
      console.log("")
      if (logs.logs) {
        console.log(logs.logs)
      } else {
        console.log(chalk.dim("No logs available"))
      }
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
