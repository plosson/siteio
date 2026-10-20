import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { resolveAppName } from "../../utils/site-config.ts"

export async function startAppCommand(
  name: string | undefined,
  options: { json?: boolean } = {}
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

    spinner.start(`Starting app ${name}`)

    const client = new SiteioClient()
    const app = await client.startApp(name)

    spinner.succeed(`Started app ${name}`)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: app }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`App ${chalk.bold(name)} started.`))
      console.log(`  Status: ${chalk.green(app.status)}`)
      console.log("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
