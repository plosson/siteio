import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { resolveSiteName } from "../../utils/site-config.ts"

export async function sitesStopCommand(
  name: string | undefined,
  options: { json?: boolean } = {}
): Promise<void> {
  const spinner = ora()

  try {
    const resolved = resolveSiteName(name, getCurrentServer()?.domain ?? "")
    if (!resolved) {
      throw new ValidationError("Site name required. Provide as argument or run from a directory with .siteio/config.json")
    }
    if (!name) {
      console.error(chalk.dim(`Using site '${resolved}' from .siteio/config.json`))
    }
    name = resolved

    spinner.start(`Stopping site ${name}`)
    const site = await new SiteioClient().stopSite(name)
    spinner.succeed(`Stopped site ${name}`)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: site }, null, 2))
    } else {
      console.error("")
      console.error(formatSuccess(`Site ${chalk.bold(name)} stopped. ${site.url} now answers 404.`))
      console.error(chalk.dim(`  Bring it back with: siteio sites start ${name}`))
      console.error("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
