import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { formatTable, formatBytes, formatInfo } from "../../utils/output.ts"
import { handleError } from "../../utils/errors.ts"

export async function listCommand(): Promise<void> {
  const spinner = ora("Fetching sites").start()

  try {
    const client = new SiteioClient()
    const sites = await client.listSites()
    spinner.stop()

    if (sites.length === 0) {
      console.error(formatInfo("No sites deployed yet."))
      console.log(JSON.stringify({ success: true, data: [] }, null, 2))
      process.exit(0)
    }

    // Format the table
    const headers = ["SUBDOMAIN", "URL", "SIZE", "AUTH", "DEPLOYED"]
    const rows = sites.map((site) => {
      const date = new Date(site.deployedAt)
      const dateStr = date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      const authStr = site.oauth ? chalk.yellow("oauth") : chalk.dim("-")
      return [site.subdomain, site.url, formatBytes(site.size), authStr, dateStr]
    })

    console.error("")
    console.error(formatTable(headers, rows))
    console.error("")

    // JSON output to stdout
    console.log(JSON.stringify({ success: true, data: sites }, null, 2))
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
