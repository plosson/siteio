import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { resolveSiteName } from "../../utils/site-config.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export async function sitesAdminCommand(name: string | undefined, options: { json?: boolean } = {}): Promise<void> {
  try {
    const server = getCurrentServer()
    const resolved = resolveSiteName(name, server?.domain ?? "")
    if (!resolved) throw new ValidationError("Site name required (argument or .siteio/config.json)")
    const admin = await new SiteioClient().getSiteAdmin(resolved)
    if (options.json) {
      console.log(JSON.stringify({ success: true, data: admin }, null, 2))
    } else {
      console.error(`Admin UI: ${chalk.cyan(admin.adminUrl)}`)
      console.error(`  Email:    ${chalk.bold(admin.email)}`)
      console.error(`  Password: ${chalk.bold(admin.password)}`)
    }
    process.exit(0)
  } catch (err) { handleError(err) }
}
