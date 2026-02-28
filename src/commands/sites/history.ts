import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { formatVersionEntry } from "../../utils/output.ts"
import { resolveSubdomain } from "../../utils/site-config.ts"

export async function historyCommand(
  subdomain: string | undefined,
  options: { json?: boolean }
): Promise<void> {
  try {
    const server = getCurrentServer()
    const resolved = resolveSubdomain(subdomain, server?.domain ?? "")
    if (!resolved) {
      throw new ValidationError("Subdomain required. Provide as argument or run from a directory with .siteio/config.json")
    }
    if (!subdomain) {
      console.error(chalk.dim(`Using site '${resolved}' from .siteio/config.json`))
    }
    subdomain = resolved

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
