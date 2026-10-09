import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { resolveSiteName } from "../../utils/site-config.ts"
import { collectEnvUpdate, type EnvFlagOptions } from "../../utils/env-args.ts"
import type { SiteInfo } from "../../types.ts"

function resolveOrThrow(name: string | undefined): string {
  const server = getCurrentServer()
  const resolved = resolveSiteName(name, server?.domain ?? "")
  if (!resolved) throw new ValidationError("Site name required (argument or .siteio/config.json)")
  if (!name) console.error(chalk.dim(`Using site '${resolved}' from .siteio/config.json`))
  return resolved
}

export function printSiteEnv(site: SiteInfo): void {
  const keys = Object.keys(site.env ?? {}).sort()
  const secrets = [...(site.secretKeys ?? [])].sort()
  if (keys.length + secrets.length === 0) return console.error(chalk.gray("  No env vars"))
  for (const key of keys) console.error(`  ${key}=${site.env![key]}`)
  for (const key of secrets) console.error(`  ${key}=••••••••  ${chalk.gray("(secret)")}`)
}

async function send(
  name: string | undefined,
  update: Parameters<SiteioClient["updateSiteEnv"]>[1],
  json?: boolean
): Promise<void> {
  const spinner = ora()
  try {
    const site = resolveOrThrow(name)
    spinner.start(`Updating env of ${site}`)
    const updated = await new SiteioClient().updateSiteEnv(site, update)
    spinner.stop()
    if (json) {
      console.log(JSON.stringify({ success: true, data: updated }, null, 2))
    } else {
      console.error(formatSuccess(`Env of ${chalk.bold(site)} updated${updated.status === "running" ? " and site restarted" : ""}`))
      printSiteEnv(updated)
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}

export async function sitesSetCommand(name: string | undefined, options: EnvFlagOptions & { json?: boolean }): Promise<void> {
  try {
    const update = await collectEnvUpdate(options)
    if (!update.env && !update.secrets) {
      throw new ValidationError("Nothing to set. Use -e KEY=value, --secret KEY=value, --secret-file or --secret-stdin")
    }
    await send(name, update, options.json)
  } catch (err) {
    handleError(err)
  }
}

export async function sitesUnsetCommand(name: string | undefined, options: { env?: string[]; json?: boolean }): Promise<void> {
  try {
    if (!options.env?.length) throw new ValidationError("Nothing to unset. Use -e KEY (repeatable)")
    await send(name, { unsetEnv: options.env }, options.json)
  } catch (err) {
    handleError(err)
  }
}
