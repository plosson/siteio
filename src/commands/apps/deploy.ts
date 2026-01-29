import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export async function deployAppCommand(
  name: string,
  options: { json?: boolean } = {}
): Promise<void> {
  const spinner = ora()

  try {
    if (!name) {
      throw new ValidationError("App name is required")
    }

    spinner.start(`Deploying app ${name}`)

    const client = new SiteioClient()
    const app = await client.deployApp(name)

    spinner.succeed(`Deployed app ${name}`)

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
