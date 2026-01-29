import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { formatTable, formatInfo, formatStatus } from "../../utils/output.ts"
import { handleError } from "../../utils/errors.ts"

export async function listAppsCommand(options: { json?: boolean } = {}): Promise<void> {
  const spinner = ora("Fetching apps").start()

  try {
    const client = new SiteioClient()
    const apps = await client.listApps()
    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: apps }, null, 2))
      process.exit(0)
    }

    if (apps.length === 0) {
      console.log(formatInfo("No apps created yet."))
      process.exit(0)
    }

    // Format the table
    const headers = ["NAME", "IMAGE", "STATUS", "PORT", "DOMAINS", "DEPLOYED"]
    const rows = apps.map((app) => {
      const date = app.deployedAt ? new Date(app.deployedAt) : null
      const dateStr = date
        ? date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : chalk.dim("-")
      const domainsStr = app.domains.length > 0 ? app.domains.join(", ") : chalk.dim("-")
      return [
        app.name,
        app.image,
        formatStatus(app.status),
        String(app.internalPort),
        domainsStr,
        dateStr,
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
