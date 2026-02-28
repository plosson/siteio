import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { confirm } from "../../utils/prompt.ts"
import { resolveSubdomain } from "../../utils/site-config.ts"

export interface RemoveSiteOptions {
  yes?: boolean
  json?: boolean
}

export async function rmCommand(subdomain: string | undefined, options: RemoveSiteOptions = {}): Promise<void> {
  const spinner = ora()

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

    if (!/^[a-z0-9-]+$/.test(subdomain)) {
      throw new ValidationError("Invalid subdomain format")
    }

    if (!options.yes) {
      const confirmed = await confirm(`Remove site ${chalk.bold(subdomain)}?`)
      if (!confirmed) {
        console.error("Cancelled")
        process.exit(0)
      }
    }

    spinner.start(`Removing ${subdomain}`)

    const client = new SiteioClient()
    await client.undeploySite(subdomain)

    spinner.succeed(`Removed ${subdomain}`)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { subdomain } }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`Site ${subdomain} has been removed.`))
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
