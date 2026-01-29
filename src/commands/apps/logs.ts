import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export interface LogsAppOptions {
  tail?: number
  json?: boolean
}

export async function logsAppCommand(
  name: string,
  options: LogsAppOptions = {}
): Promise<void> {
  const spinner = ora()

  try {
    if (!name) {
      throw new ValidationError("App name is required")
    }

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
