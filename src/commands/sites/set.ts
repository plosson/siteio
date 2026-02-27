import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export interface SetSiteOptions {
  domain?: string[]
  json?: boolean
}

export async function setSiteCommand(
  subdomain: string,
  options: SetSiteOptions = {}
): Promise<void> {
  const spinner = ora()

  try {
    if (!subdomain) {
      throw new ValidationError("Subdomain is required")
    }

    const client = new SiteioClient()

    if (!options.domain || options.domain.length === 0) {
      throw new ValidationError("No updates specified. Use --domain to set custom domains.")
    }

    spinner.start(`Updating site ${subdomain}`)
    const site = await client.updateSiteDomains(subdomain, options.domain)
    spinner.succeed(`Updated site ${subdomain}`)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: site }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`Site ${chalk.bold(subdomain)} updated.`))
      console.log("")
      if (site.domains && site.domains.length > 0) {
        console.log(chalk.bold("Custom domains:"))
        for (const d of site.domains) {
          console.log(`  ${chalk.cyan(d)}`)
        }
      } else {
        console.log(chalk.dim("No custom domains set."))
      }
      console.log("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
