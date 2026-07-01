import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { resolvePocketName } from "../../utils/site-config.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export async function pocketInfoCommand(name: string | undefined, options: { json?: boolean } = {}): Promise<void> {
  try {
    const server = getCurrentServer()
    const resolved = resolvePocketName(name, server?.domain ?? "")
    if (!resolved) throw new ValidationError("Pocket name required (argument or .siteio/config.json)")
    const info = await new SiteioClient().getPocket(resolved)
    if (options.json) {
      console.log(JSON.stringify({ success: true, data: info }, null, 2))
    } else {
      console.error(`${chalk.bold(info.name)}`)
      console.error(`  URL:     ${chalk.cyan(info.url)}`)
      console.error(`  Admin:   ${chalk.cyan(info.adminUrl)}`)
      console.error(`  Status:  ${info.status}`)
      console.error(`  Version: ${info.version ?? "-"} (PocketBase ${info.pocketbaseVersion})`)
    }
    process.exit(0)
  } catch (err) { handleError(err) }
}
