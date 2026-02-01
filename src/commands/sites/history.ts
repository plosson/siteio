import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { handleError } from "../../utils/errors.ts"
import { formatBytes } from "../../utils/output.ts"

export async function historyCommand(
  subdomain: string,
  options: { json?: boolean }
): Promise<void> {
  try {
    const client = new SiteioClient()
    const history = await client.getSiteHistory(subdomain)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: history }, null, 2))
    } else {
      if (history.length === 0) {
        console.error(chalk.yellow("No history found for this site."))
        console.error(chalk.dim("History is created when you deploy over an existing site."))
      } else {
        console.error(chalk.cyan(`History for ${subdomain}:`))
        console.error("")
        for (const version of history) {
          const date = new Date(version.deployedAt).toLocaleString()
          const user = version.deployedBy ? chalk.blue(version.deployedBy.padEnd(12)) : chalk.dim("unknown".padEnd(12))
          console.error(`  ${chalk.bold(`v${version.version}`)}  ${user}  ${date}  ${formatBytes(version.size)}`)
        }
        console.error("")
        console.error(chalk.dim(`Use 'siteio sites rollback ${subdomain} <version>' to restore a version.`))
      }
    }
  } catch (err) {
    handleError(err)
  }
}
