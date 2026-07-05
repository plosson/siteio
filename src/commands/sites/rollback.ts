import chalk from "chalk"
import ora from "ora"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { confirm } from "../../utils/prompt.ts"
import { formatBytes, formatVersionEntry } from "../../utils/output.ts"
import { resolveSiteName } from "../../utils/site-config.ts"

export async function sitesRollbackCommand(
  name: string | undefined,
  version: string | undefined,
  options: { json?: boolean; yes?: boolean }
): Promise<void> {
  const spinner = ora()

  try {
    const server = getCurrentServer()
    const resolved = resolveSiteName(name, server?.domain ?? "")
    if (!resolved) {
      throw new ValidationError("Site name required. Pass it as an argument or run from a directory with .siteio/config.json")
    }
    if (!name) {
      console.error(chalk.dim(`Using site '${resolved}' from .siteio/config.json`))
    }

    const client = new SiteioClient()

    // If no version specified, show history and let user choose
    if (!version) {
      const history = await client.getSiteHistory(resolved)
      if (history.length === 0) {
        throw new ValidationError("No history found for this site.")
      }

      console.error(chalk.cyan(`Available versions for ${resolved}:`))
      console.error("")
      for (const v of history) {
        console.error(formatVersionEntry(v))
      }
      console.error("")
      throw new ValidationError(`Please specify a version: siteio sites rollback ${resolved} -v <version>`)
    }

    const versionNum = parseInt(version, 10)
    if (isNaN(versionNum)) {
      throw new ValidationError("Version must be a number")
    }

    // Confirm rollback. Only the code rolls back — the site's database and
    // uploaded files stay as they are.
    if (!options.yes) {
      const proceed = await confirm(`Rollback ${resolved} code to version ${versionNum}? (data is not affected)`)
      if (!proceed) {
        process.exit(0)
      }
    }

    spinner.start(`Rolling back to version ${versionNum}`)
    const site = await client.rollbackSite(resolved, versionNum)
    spinner.succeed("Rollback complete")

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: site }, null, 2))
    } else {
      console.log("")
      console.log(chalk.green(`Site rolled back to version ${versionNum}`))
      console.log(`  URL: ${chalk.cyan(site.url)}`)
      console.log(`  Size: ${formatBytes(site.size)}`)
      console.log("")
    }
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
