import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { formatTable, formatBytes, formatInfo, formatStatus, formatTls, formatDeployedDate } from "../../utils/output.ts"
import { handleError } from "../../utils/errors.ts"

export async function sitesListCommand(options: { json?: boolean } = {}): Promise<void> {
  const spinner = ora("Fetching sites").start()

  try {
    const client = new SiteioClient()
    const sites = await client.listSites()
    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: sites }, null, 2))
      process.exit(0)
    }

    if (sites.length === 0) {
      console.log(formatInfo("No sites deployed yet."))
      process.exit(0)
    }

    // Format the table
    const headers = ["NAME", "URL", "SIZE", "TLS", "DOMAINS", "STATUS", "PB", "DEPLOYED"]
    const rows = sites.map((site) => {
      // Show the custom domains themselves — a bare count told you nothing about
      // where the site actually lives. Beyond two, name the first and count the rest.
      const customs = site.domains ?? []
      const domainsStr =
        customs.length === 0
          ? chalk.dim("-")
          : customs.length <= 2
            ? chalk.cyan(customs.join(", "))
            : chalk.cyan(`${customs[0]}`) + chalk.dim(` +${customs.length - 1}`)
      return [
        site.name,
        site.url,
        formatBytes(site.size),
        formatTls(site.tls),
        domainsStr,
        formatStatus(site.status),
        site.pocketbaseVersion,
        formatDeployedDate(site.deployedAt),
      ]
    })

    console.log("")
    console.log(formatTable(headers, rows))
    console.log("")
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
