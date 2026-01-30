import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { formatTable, formatBytes, formatInfo } from "../../utils/output.ts"
import { handleError } from "../../utils/errors.ts"

export async function listCommand(options: { json?: boolean } = {}): Promise<void> {
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
    const headers = ["SUBDOMAIN", "URL", "SIZE", "TLS", "AUTH", "DEPLOYED"]
    const rows = sites.map((site) => {
      const date = new Date(site.deployedAt)
      const dateStr = date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      const authStr = site.oauth ? chalk.yellow("oauth") : chalk.dim("-")
      const tlsStr =
        site.tls === "valid"
          ? chalk.green("✓")
          : site.tls === "pending"
            ? chalk.yellow("…")
            : site.tls === "error"
              ? chalk.red("✗")
              : chalk.dim("-")
      return [site.subdomain, site.url, formatBytes(site.size), tlsStr, authStr, dateStr]
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
