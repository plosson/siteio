import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { formatTable, formatBytes, formatInfo, formatStatus, formatTls, formatDeployedDate } from "../../utils/output.ts"
import { handleError } from "../../utils/errors.ts"

export async function pocketListCommand(options: { json?: boolean } = {}): Promise<void> {
  const spinner = ora("Fetching pockets").start()

  try {
    const client = new SiteioClient()
    const pockets = await client.listPockets()
    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: pockets }, null, 2))
      process.exit(0)
    }

    if (pockets.length === 0) {
      console.log(formatInfo("No pockets deployed yet."))
      process.exit(0)
    }

    // Format the table
    const headers = ["NAME", "URL", "SIZE", "TLS", "DOMAINS", "STATUS", "PB", "DEPLOYED"]
    const rows = pockets.map((pocket) => {
      const domainsStr = pocket.domains && pocket.domains.length > 0
        ? chalk.cyan(`${pocket.domains.length}`)
        : chalk.dim("-")
      return [
        pocket.name,
        pocket.url,
        formatBytes(pocket.size),
        formatTls(pocket.tls),
        domainsStr,
        formatStatus(pocket.status),
        pocket.pocketbaseVersion,
        formatDeployedDate(pocket.deployedAt),
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
