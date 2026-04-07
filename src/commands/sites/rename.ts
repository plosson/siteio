import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { resolveSubdomain } from "../../utils/site-config.ts"

export async function renameCommand(
  subdomain: string | undefined,
  newSubdomain: string,
  options: { json?: boolean } = {}
): Promise<void> {
  const spinner = ora()

  try {
    const server = getCurrentServer()
    const resolved = resolveSubdomain(subdomain, server?.domain ?? "")
    if (!resolved) {
      throw new ValidationError("Subdomain required. Use -s <subdomain> or run from a directory with .siteio/config.json")
    }
    if (!subdomain) {
      console.error(chalk.dim(`Using site '${resolved}' from .siteio/config.json`))
    }
    subdomain = resolved

    if (!/^[a-z0-9-]+$/.test(newSubdomain)) {
      throw new ValidationError("New subdomain must contain only lowercase letters, numbers, and hyphens")
    }

    if (newSubdomain === subdomain) {
      throw new ValidationError("New subdomain is the same as the current one")
    }

    spinner.start(`Renaming ${subdomain} → ${newSubdomain}`)

    const client = new SiteioClient()
    const site = await client.renameSite(subdomain, newSubdomain)

    spinner.succeed(`Renamed ${subdomain} → ${newSubdomain}`)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: site }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`Site renamed to ${chalk.bold(newSubdomain)}`))
      console.log(`  ${chalk.cyan(site.url)}`)
      console.log("")
      console.log(chalk.dim("Note: The old URL will no longer work."))
      console.log("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
