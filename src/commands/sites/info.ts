import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { handleError } from "../../utils/errors.ts"

export async function infoCommand(subdomain: string): Promise<void> {
  const spinner = ora()

  try {
    const client = new SiteioClient()

    spinner.start(`Fetching site info for ${subdomain}`)
    const sites = await client.listSites()
    spinner.stop()

    const site = sites.find((s) => s.subdomain === subdomain)

    if (!site) {
      console.error(chalk.red(`Site '${subdomain}' not found`))
      process.exit(1)
    }

    // JSON output to stdout
    console.log(JSON.stringify({ success: true, data: site }, null, 2))

    // Human-readable output to stderr
    console.error("")
    console.error(chalk.bold(`Site: ${site.subdomain}`))
    console.error(`  URL:      ${chalk.cyan(site.url)}`)
    console.error(`  Size:     ${formatSize(site.size)}`)
    console.error(`  Deployed: ${new Date(site.deployedAt).toLocaleString()}`)
    console.error("")

    if (site.oauth) {
      console.error(chalk.bold("Authentication:"))
      if (site.oauth.allowedEmails && site.oauth.allowedEmails.length > 0) {
        console.error(`  Allowed emails:`)
        for (const email of site.oauth.allowedEmails) {
          console.error(`    - ${chalk.cyan(email)}`)
        }
      }
      if (site.oauth.allowedDomain) {
        console.error(`  Allowed domain: ${chalk.cyan(site.oauth.allowedDomain)}`)
      }
      if (site.oauth.allowedGroups && site.oauth.allowedGroups.length > 0) {
        console.error(`  Allowed groups:`)
        for (const group of site.oauth.allowedGroups) {
          console.error(`    - ${chalk.cyan(group)}`)
        }
      }
    } else {
      console.error(chalk.gray("Authentication: None (public)"))
    }
    console.error("")

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
