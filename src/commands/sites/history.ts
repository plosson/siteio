import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { handleError } from "../../utils/errors.ts"
import { formatVersionEntry } from "../../utils/output.ts"

export async function historyCommand(
  subdomain: string,
  options: { json?: boolean }
): Promise<void> {
  try {
    const client = new SiteioClient()
    const history = await client.getSiteHistory(subdomain)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: history }, null, 2))
      return
    }

    if (history.length === 0) {
      console.error(chalk.yellow("No history found for this site."))
      console.error(chalk.dim("History is created when you deploy over an existing site."))
      return
    }

    console.error(chalk.cyan(`History for ${subdomain}:`))
    console.error("")
    for (const version of history) {
      console.error(formatVersionEntry(version))
    }
    console.error("")
    console.error(chalk.dim(`Use 'siteio sites rollback ${subdomain} <version>' to restore a version.`))
  } catch (err) {
    handleError(err)
  }
}
