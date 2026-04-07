import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { resolveSubdomain } from "../../utils/site-config.ts"

function resolveOrThrow(subdomain: string | undefined): string {
  const server = getCurrentServer()
  const resolved = resolveSubdomain(subdomain, server?.domain ?? "")
  if (!resolved) {
    throw new ValidationError("Subdomain required. Use -s <subdomain> or run from a directory with .siteio/config.json")
  }
  if (!subdomain) {
    console.error(chalk.dim(`Using site '${resolved}' from .siteio/config.json`))
  }
  return resolved
}

export async function domainAddCommand(
  domain: string,
  options: { subdomain?: string; json?: boolean }
): Promise<void> {
  const spinner = ora()

  try {
    const subdomain = resolveOrThrow(options.subdomain)
    const client = new SiteioClient()

    spinner.start(`Adding domain ${domain} to ${subdomain}`)
    const site = await client.getSite(subdomain)
    if (!site) {
      throw new ValidationError(`Site '${subdomain}' not found`)
    }

    const domains = site.domains || []
    if (domains.includes(domain)) {
      spinner.stop()
      console.error(chalk.yellow(`Domain ${domain} is already configured on ${subdomain}`))
      process.exit(0)
    }

    domains.push(domain)
    await client.updateSiteDomains(subdomain, domains)
    spinner.succeed(`Added domain ${domain} to ${subdomain}`)

    if (options.json) {
      const updated = await client.getSite(subdomain)
      console.log(JSON.stringify({ success: true, data: updated }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`Domain ${chalk.cyan(domain)} added to site ${chalk.bold(subdomain)}`))
      console.log(`  ${chalk.cyan(`https://${domain}`)}`)
      console.log("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}

export async function domainRemoveCommand(
  domain: string,
  options: { subdomain?: string; json?: boolean }
): Promise<void> {
  const spinner = ora()

  try {
    const subdomain = resolveOrThrow(options.subdomain)
    const client = new SiteioClient()

    spinner.start(`Removing domain ${domain} from ${subdomain}`)
    const site = await client.getSite(subdomain)
    if (!site) {
      throw new ValidationError(`Site '${subdomain}' not found`)
    }

    const domains = site.domains || []
    if (!domains.includes(domain)) {
      spinner.stop()
      console.error(chalk.yellow(`Domain ${domain} is not configured on ${subdomain}`))
      process.exit(0)
    }

    const updated = domains.filter((d) => d !== domain)
    await client.updateSiteDomains(subdomain, updated)
    spinner.succeed(`Removed domain ${domain} from ${subdomain}`)

    if (options.json) {
      const updatedSite = await client.getSite(subdomain)
      console.log(JSON.stringify({ success: true, data: updatedSite }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`Domain ${chalk.cyan(domain)} removed from site ${chalk.bold(subdomain)}`))
      console.log("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}

export async function domainListCommand(
  options: { subdomain?: string; json?: boolean }
): Promise<void> {
  const spinner = ora()

  try {
    const subdomain = resolveOrThrow(options.subdomain)
    const client = new SiteioClient()

    spinner.start(`Fetching domains for ${subdomain}`)
    const site = await client.getSite(subdomain)
    if (!site) {
      throw new ValidationError(`Site '${subdomain}' not found`)
    }
    spinner.stop()

    const domains = site.domains || []

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { subdomain, domains } }, null, 2))
    } else {
      console.log("")
      console.log(chalk.bold(`Domains for ${subdomain}:`))
      console.log(`  ${chalk.cyan(site.url)} ${chalk.dim("(primary)")}`)
      if (domains.length > 0) {
        for (const d of domains) {
          console.log(`  ${chalk.cyan(`https://${d}`)}`)
        }
      } else {
        console.log(chalk.dim("  No custom domains configured."))
      }
      console.log("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
