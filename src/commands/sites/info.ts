import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { resolveSubdomain } from "../../utils/site-config.ts"

export async function infoCommand(subdomain: string | undefined, options: { json?: boolean } = {}): Promise<void> {
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

    const client = new SiteioClient()

    spinner.start(`Fetching site info for ${subdomain}`)
    const sites = await client.listSites()
    spinner.stop()

    const site = sites.find((s) => s.subdomain === subdomain)

    if (!site) {
      console.error(chalk.red(`Site '${subdomain}' not found`))
      process.exit(1)
    }

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: site }, null, 2))
      process.exit(0)
    }

    // Human-readable output
    console.log("")
    console.log(chalk.bold(`Site: ${site.subdomain}`))
    console.log(`  URL:      ${chalk.cyan(site.url)}`)
    if (site.domains && site.domains.length > 0) {
      console.log(`  Domains:`)
      for (const d of site.domains) {
        console.log(`            ${chalk.cyan(`https://${d}`)}`)
      }
    }
    console.log(`  Size:     ${formatSize(site.size)}`)
    console.log(`  Deployed: ${new Date(site.deployedAt).toLocaleString()}`)
    console.log("")

    if (site.oauth) {
      console.log(chalk.bold("Authentication:"))
      if (site.oauth.allowedEmails && site.oauth.allowedEmails.length > 0) {
        console.log(`  Allowed emails:`)
        for (const email of site.oauth.allowedEmails) {
          console.log(`    - ${chalk.cyan(email)}`)
        }
      }
      if (site.oauth.allowedDomain) {
        console.log(`  Allowed domain: ${chalk.cyan(site.oauth.allowedDomain)}`)
      }
      if (site.oauth.allowedGroups && site.oauth.allowedGroups.length > 0) {
        console.log(`  Allowed groups:`)
        for (const group of site.oauth.allowedGroups) {
          console.log(`    - ${chalk.cyan(group)}`)
        }
      }
    } else {
      console.log(chalk.gray("Authentication: None (public)"))
    }
    console.log("")

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
