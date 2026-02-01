import chalk from "chalk"
import ora from "ora"
import { SiteioClient } from "../../lib/client.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { confirm } from "../../utils/prompt.ts"
import { formatBytes, formatVersionEntry } from "../../utils/output.ts"

export async function rollbackCommand(
  subdomain: string,
  version: string | undefined,
  options: { json?: boolean; yes?: boolean }
): Promise<void> {
  const spinner = ora()

  try {
    const client = new SiteioClient()

    // If no version specified, show history and let user choose
    if (!version) {
      const history = await client.getSiteHistory(subdomain)
      if (history.length === 0) {
        throw new ValidationError("No history found for this site.")
      }

      console.error(chalk.cyan(`Available versions for ${subdomain}:`))
      console.error("")
      for (const v of history) {
        console.error(formatVersionEntry(v))
      }
      console.error("")
      throw new ValidationError(`Please specify a version: siteio sites rollback ${subdomain} <version>`)
    }

    const versionNum = parseInt(version, 10)
    if (isNaN(versionNum)) {
      throw new ValidationError("Version must be a number")
    }

    // Confirm rollback
    if (!options.yes) {
      const proceed = await confirm(`Rollback ${subdomain} to version ${versionNum}?`)
      if (!proceed) {
        process.exit(0)
      }
    }

    spinner.start(`Rolling back to version ${versionNum}`)
    const site = await client.rollbackSite(subdomain, versionNum)
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
