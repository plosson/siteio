import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { formatTable, formatInfo, formatStatus, formatTls, formatDeployedDate } from "../../utils/output.ts"
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
    const headers = ["NAME", "URL", "SOURCE", "STATUS", "TLS", "PORT", "DOMAINS", "DEPLOYED"]
    const rows = apps.map((app) => {
      const domainsStr = app.domains && app.domains.length > 0
        ? chalk.cyan(`${app.domains.length}`)
        : chalk.dim("-")

      // Format source: show shortened git URL or image name
      let sourceStr: string
      if (app.git) {
        // Extract repo name from URL (e.g., "github.com/user/repo" -> "user/repo")
        const match = app.git.repoUrl.match(/(?:github\.com|gitlab\.com|bitbucket\.org)[/:](.+?)(?:\.git)?$/)
        sourceStr = match ? chalk.blue(match[1]) : chalk.blue(app.git.repoUrl)
      } else {
        sourceStr = app.image
      }

      return [
        app.name,
        app.url,
        sourceStr,
        formatStatus(app.status),
        formatTls(app.tls),
        String(app.internalPort),
        domainsStr,
        formatDeployedDate(app.deployedAt),
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
