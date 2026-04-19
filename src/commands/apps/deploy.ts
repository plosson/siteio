import { readFileSync } from "fs"
import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { resolveAppName, saveProjectConfig } from "../../utils/site-config.ts"

export interface DeployAppOptions {
  noCache?: boolean
  file?: string
  json?: boolean
}

export async function deployAppCommand(
  name: string | undefined,
  options: DeployAppOptions = {}
): Promise<void> {
  const spinner = ora()

  try {
    const server = getCurrentServer()
    const resolved = resolveAppName(name, server?.domain ?? "")
    if (!resolved) {
      throw new ValidationError("App name required. Provide as argument or run from a directory with .siteio/config.json")
    }
    if (!name) {
      console.error(chalk.dim(`Using app '${resolved}' from .siteio/config.json`))
    }
    name = resolved

    // Read the local Dockerfile up-front so we fail fast on bad paths
    let dockerfileContent: string | undefined
    if (options.file) {
      try {
        dockerfileContent = readFileSync(options.file, "utf-8")
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new ValidationError(`Failed to read Dockerfile at '${options.file}': ${message}`)
      }
    }

    const action = options.noCache ? "Building (no cache) and deploying" : "Deploying"
    spinner.start(`${action} app ${name}`)

    const client = new SiteioClient()
    const app = await client.deployApp(name, {
      noCache: options.noCache,
      dockerfileContent,
    })

    spinner.succeed(`Deployed app ${name}`)

    // Save config so future commands don't need the app name
    if (server) {
      saveProjectConfig({ app: name, domain: server.domain })
    }

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: app }, null, 2))
    } else {
      const statusColor = app.status === "running" ? chalk.green : chalk.yellow

      console.log("")
      console.log(formatSuccess(`App ${chalk.bold(name)} deployed successfully!`))
      console.log("")
      console.log(`  Status: ${statusColor(app.status)}`)
      if (app.domains.length > 0) {
        console.log(`  URL:    ${chalk.cyan(`https://${app.domains[0]}`)}`)
        if (app.domains.length > 1) {
          console.log(`  Domains:`)
          for (const d of app.domains) {
            console.log(`    ${chalk.cyan(`https://${d}`)}`)
          }
        }
      }
      console.log("")

      // If the agent returned deploy-time warnings (compose apps only), surface them
      const warnings = (app as unknown as { warnings?: string[] }).warnings
      if (warnings && warnings.length > 0) {
        console.log("")
        console.log(chalk.yellow("Warnings:"))
        for (const w of warnings) {
          console.log(chalk.yellow(`  • ${w}`))
        }
      }
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
