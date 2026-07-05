import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { formatVersionEntry } from "../../utils/output.ts"
import { resolveSiteName } from "../../utils/site-config.ts"

export async function sitesHistoryCommand(
  name: string | undefined,
  options: { json?: boolean }
): Promise<void> {
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
    const history = await client.getSiteHistory(resolved)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: history }, null, 2))
      return
    }

    if (history.length === 0) {
      console.error(chalk.yellow("No history found for this site."))
      console.error(chalk.dim("History is created when you deploy over an existing site."))
      return
    }

    console.error(chalk.cyan(`History for ${resolved}:`))
    console.error("")
    for (const version of history) {
      console.error(formatVersionEntry(version))
    }
    console.error("")
    console.error(chalk.dim(`Use 'siteio sites rollback -v <version>' to restore a version.`))
  } catch (err) {
    handleError(err)
  }
}
