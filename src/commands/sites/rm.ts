import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { resolveSiteName } from "../../utils/site-config.ts"
import { confirm } from "../../utils/prompt.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export async function sitesRmCommand(name: string | undefined, options: { yes?: boolean; json?: boolean } = {}): Promise<void> {
  try {
    const server = getCurrentServer()
    const resolved = resolveSiteName(name, server?.domain ?? "")
    if (!resolved) throw new ValidationError("Site name required (argument or .siteio/config.json)")
    if (!options.yes) {
      const ok = await confirm(`Remove site '${resolved}' and its data? This cannot be undone.`)
      if (!ok) process.exit(0)
    }
    await new SiteioClient().deleteSite(resolved)
    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { deleted: resolved } }, null, 2))
    } else {
      console.error(formatSuccess(`Removed site ${chalk.bold(resolved)}`))
    }
    process.exit(0)
  } catch (err) { handleError(err) }
}
