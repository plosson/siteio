import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export async function restartAppCommand(
  name: string,
  options: { json?: boolean } = {}
): Promise<void> {
  const spinner = ora()

  try {
    if (!name) {
      throw new ValidationError("App name is required")
    }

    spinner.start(`Restarting app ${name}`)

    const client = new SiteioClient()
    const app = await client.restartApp(name)

    spinner.succeed(`Restarted app ${name}`)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: app }, null, 2))
    } else {
      const statusColor = app.status === "running" ? chalk.green : chalk.yellow

      console.log("")
      console.log(formatSuccess(`App ${chalk.bold(name)} restarted.`))
      console.log(`  Status: ${statusColor(app.status)}`)
      console.log("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
