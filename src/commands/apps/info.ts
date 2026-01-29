import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { formatStatus } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import type { App } from "../../types.ts"

export async function infoAppCommand(
  name: string,
  options: { json?: boolean } = {}
): Promise<void> {
  const spinner = ora()

  try {
    if (!name) {
      throw new ValidationError("App name is required")
    }

    const client = new SiteioClient()

    spinner.start(`Fetching app info for ${name}`)
    const app: App = await client.getApp(name)
    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: app }, null, 2))
      process.exit(0)
    }

    // Human-readable output
    console.log("")
    console.log(chalk.bold(`App: ${app.name}`))
    console.log(`  Type:    ${app.type}`)
    console.log(`  Image:   ${app.image}`)
    console.log(`  Status:  ${formatStatus(app.status)}`)
    console.log(`  Port:    ${app.internalPort}`)
    console.log(`  Restart: ${app.restartPolicy}`)
    console.log(`  Created: ${new Date(app.createdAt).toLocaleString()}`)
    if (app.deployedAt) {
      console.log(`  Deployed: ${new Date(app.deployedAt).toLocaleString()}`)
    }
    console.log("")

    // Domains
    if (app.domains.length > 0) {
      console.log(chalk.bold("Domains:"))
      for (const domain of app.domains) {
        console.log(`  - ${chalk.cyan(domain)}`)
      }
      console.log("")
    }

    // Environment variables
    const envKeys = Object.keys(app.env)
    if (envKeys.length > 0) {
      console.log(chalk.bold("Environment:"))
      for (const key of envKeys) {
        console.log(`  ${key}=${chalk.dim(app.env[key])}`)
      }
      console.log("")
    }

    // Volumes
    if (app.volumes.length > 0) {
      console.log(chalk.bold("Volumes:"))
      for (const vol of app.volumes) {
        console.log(`  ${vol.name}:${vol.mountPath}`)
      }
      console.log("")
    }

    // OAuth
    if (app.oauth) {
      console.log(chalk.bold("Authentication:"))
      if (app.oauth.allowedEmails && app.oauth.allowedEmails.length > 0) {
        console.log(`  Allowed emails:`)
        for (const email of app.oauth.allowedEmails) {
          console.log(`    - ${chalk.cyan(email)}`)
        }
      }
      if (app.oauth.allowedDomain) {
        console.log(`  Allowed domain: ${chalk.cyan(app.oauth.allowedDomain)}`)
      }
      if (app.oauth.allowedGroups && app.oauth.allowedGroups.length > 0) {
        console.log(`  Allowed groups:`)
        for (const group of app.oauth.allowedGroups) {
          console.log(`    - ${chalk.cyan(group)}`)
        }
      }
      console.log("")
    }

    if (app.containerId) {
      console.log(chalk.dim(`Container ID: ${app.containerId}`))
      console.log("")
    }

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
