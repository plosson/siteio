import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { watchServices, type ServiceProblem } from "../../lib/app-health.ts"
import { waitForUrl } from "../../lib/verification.ts"
import { formatError, formatSuccess, printComposeWarnings } from "../../utils/output.ts"
import { ApiError, handleError, ValidationError } from "../../utils/errors.ts"
import { resolveAppName, saveProjectConfig } from "../../utils/site-config.ts"
import { readFlagFile } from "../../utils/files.ts"

export interface DeployAppOptions {
  noCache?: boolean
  file?: string
  json?: boolean
  wait?: boolean // false with --no-wait: skip the post-deploy checks
  waitTimeout?: number // seconds to wait for the public URL
}

export interface DeployChecks {
  services: ServiceProblem[]
  url?: { url: string; ok: boolean; status?: number; error?: string }
}

function checksPassed(checks: DeployChecks): boolean {
  return checks.services.length === 0 && checks.url?.ok !== false
}

/**
 * Watch the containers for a short window, then wait for the public URL to
 * answer over HTTPS. The URL is not checked when a container already failed.
 */
async function runDeployChecks(
  client: SiteioClient,
  name: string,
  url: string | undefined,
  urlTimeoutMs: number,
  spinner: ReturnType<typeof ora>
): Promise<DeployChecks> {
  spinner.start("Checking that the containers stay up")
  let services: ServiceProblem[] = []
  try {
    services = await watchServices(() => client.getAppStatus(name))
    if (services.length > 0) {
      spinner.fail("Some containers are failing")
      return { services }
    }
    spinner.succeed("Containers are up")
  } catch (err) {
    // Agents older than the status endpoint answer 404: skip, don't fail the deploy
    if (!(err instanceof ApiError && err.statusCode === 404)) throw err
    spinner.warn("Container check skipped: the agent is too old (run 'siteio update' then 'siteio agent restart' on the server)")
  }

  if (!url) return { services }

  spinner.start(`Waiting for ${url}`)
  const result = await waitForUrl(url, { timeoutMs: urlTimeoutMs }, (_attempt, check) => {
    if (!check.ok) spinner.text = `Waiting for ${url}: ${check.reason}`
  })
  if (result.success) {
    spinner.succeed(`${url} responds (HTTP ${result.status})`)
  } else {
    spinner.fail(`${url} does not respond: ${result.error}`)
  }
  return { services, url: { url, ok: result.success, status: result.status, error: result.error } }
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

    const waitTimeout = options.waitTimeout ?? 90
    if (!Number.isInteger(waitTimeout) || waitTimeout < 0) {
      throw new ValidationError("--wait-timeout must be a whole number of seconds (0 or more)")
    }

    // Read the local Dockerfile up-front so we fail fast on bad paths
    const dockerfileContent = readFlagFile(options.file, "Dockerfile")

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

    const checks = options.wait === false ? undefined : await runDeployChecks(client, name, app.url, waitTimeout * 1000, spinner)
    const ok = !checks || checksPassed(checks)

    if (options.json) {
      console.log(JSON.stringify({ success: ok, data: app, ...(checks && { checks }) }, null, 2))
    } else {
      const statusColor = app.status === "running" ? chalk.green : chalk.yellow

      console.log("")
      if (ok) {
        console.log(formatSuccess(`App ${chalk.bold(name)} deployed successfully!`))
      } else {
        console.log(formatError(`App ${chalk.bold(name)} was deployed but is not working`))
      }
      console.log("")
      console.log(`  Status: ${statusColor(app.status)}`)
      if (app.url) {
        console.log(`  URL:    ${chalk.cyan(app.url)}`)
      }
      if (app.domains.length > 1) {
        console.log(`  Domains:`)
        for (const d of app.domains) {
          console.log(`    ${chalk.cyan(`https://${d}`)}`)
        }
      }
      console.log("")

      // Show why each failing container stopped
      for (const { service, problem } of checks?.services ?? []) {
        console.log(chalk.red(`  ${service} ${problem}. Last log lines:`))
        const logs = await client
          .getAppLogs(name, { tail: 15, ...(app.compose && { service }) })
          .then((l) => l.logs.trimEnd())
          .catch((err) => `(could not fetch logs: ${err instanceof Error ? err.message : String(err)})`)
        console.log(chalk.dim(logs.replace(/^/gm, "    ")))
        console.log("")
      }

      printComposeWarnings(app.warnings)
    }
    process.exit(ok ? 0 : 1)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
