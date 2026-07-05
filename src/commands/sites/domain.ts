import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { resolveSiteName } from "../../utils/site-config.ts"

function resolveOrThrow(name: string | undefined): string {
  const server = getCurrentServer()
  const resolved = resolveSiteName(name, server?.domain ?? "")
  if (!resolved) {
    throw new ValidationError("Site name required. Use -n <name> or run from a directory with .siteio/config.json")
  }
  if (!name) {
    console.error(chalk.dim(`Using site '${resolved}' from .siteio/config.json`))
  }
  return resolved
}

export async function domainAddCommand(
  domain: string,
  options: { name?: string; json?: boolean }
): Promise<void> {
  const spinner = ora()

  try {
    const name = resolveOrThrow(options.name)
    const client = new SiteioClient()

    spinner.start(`Adding domain ${domain} to ${name}`)
    const site = await client.getSite(name)

    const domains = site.domains || []
    if (domains.includes(domain)) {
      spinner.stop()
      console.error(chalk.yellow(`Domain ${domain} is already configured on ${name}`))
      process.exit(0)
    }

    domains.push(domain)
    const updated = await client.updateSiteDomains(name, domains)
    spinner.succeed(`Added domain ${domain} to ${name}`)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: updated }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`Domain ${chalk.cyan(domain)} added to site ${chalk.bold(name)}`))
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
  options: { name?: string; json?: boolean }
): Promise<void> {
  const spinner = ora()

  try {
    const name = resolveOrThrow(options.name)
    const client = new SiteioClient()

    spinner.start(`Removing domain ${domain} from ${name}`)
    const site = await client.getSite(name)

    const domains = site.domains || []
    if (!domains.includes(domain)) {
      spinner.stop()
      console.error(chalk.yellow(`Domain ${domain} is not configured on ${name}`))
      process.exit(0)
    }

    const updated = await client.updateSiteDomains(name, domains.filter((d) => d !== domain))
    spinner.succeed(`Removed domain ${domain} from ${name}`)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: updated }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`Domain ${chalk.cyan(domain)} removed from site ${chalk.bold(name)}`))
      console.log("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}

export async function domainListCommand(
  options: { name?: string; json?: boolean }
): Promise<void> {
  const spinner = ora()

  try {
    const name = resolveOrThrow(options.name)
    const client = new SiteioClient()

    spinner.start(`Fetching domains for ${name}`)
    const site = await client.getSite(name)
    spinner.stop()

    const domains = site.domains || []

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { name, domains } }, null, 2))
    } else {
      console.log("")
      console.log(chalk.bold(`Domains for ${name}:`))
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
