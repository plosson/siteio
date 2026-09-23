import chalk from "chalk"
import ora from "ora"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { confirm } from "../../utils/prompt.ts"
import { resolveSiteName } from "../../utils/site-config.ts"
import type { SiteUpgradeResult } from "../../types.ts"

type Outcome = { name: string; ok: true; result: SiteUpgradeResult } | { name: string; ok: false; error: string }

// Move sites to the agent's PocketBase version, one at a time. The agent
// snapshots pb_data first and restores it if the new version doesn't start,
// so a failure leaves that site on its old version and we carry on.
export async function sitesUpgradeCommand(
  name: string | undefined,
  options: { all?: boolean; yes?: boolean; json?: boolean }
): Promise<void> {
  const spinner = ora()

  try {
    const client = new SiteioClient()
    let names: string[]
    if (options.all) {
      if (name) throw new ValidationError("Pass either a site name or --all, not both")
      names = (await client.listSites()).map((s) => s.name)
      if (names.length === 0) throw new ValidationError("No sites to upgrade")
    } else {
      const resolved = resolveSiteName(name, getCurrentServer()?.domain ?? "")
      if (!resolved) {
        throw new ValidationError("Site name required. Pass it as an argument, use --all, or run from a directory with .siteio/config.json")
      }
      names = [resolved]
    }

    if (!options.yes) {
      const proceed = await confirm(
        `Upgrade PocketBase for ${names.length === 1 ? names[0] : `${names.length} sites`}? Each site restarts; pb_data is backed up first.`
      )
      if (!proceed) process.exit(0)
    }

    const outcomes: Outcome[] = []
    for (const site of names) {
      spinner.start(`Upgrading ${site}`)
      try {
        const result = await client.upgradeSite(site)
        outcomes.push({ name: site, ok: true, result })
        if (result.upgraded) spinner.succeed(`${site}: ${result.from} → ${result.to} ${chalk.dim(`(backup: ${result.backup})`)}`)
        else spinner.info(`${site}: already on ${result.to}`)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        outcomes.push({ name: site, ok: false, error })
        spinner.fail(`${site}: ${error}`)
      }
    }

    const failed = outcomes.filter((o) => !o.ok)
    if (options.json) {
      console.log(JSON.stringify({ success: failed.length === 0, data: outcomes }, null, 2))
    } else if (names.length > 1) {
      const upgraded = outcomes.filter((o) => o.ok && o.result.upgraded).length
      console.error("")
      console.error(`${upgraded} upgraded, ${outcomes.length - upgraded - failed.length} already current, ${failed.length} failed`)
    }
    process.exit(failed.length === 0 ? 0 : 1)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
