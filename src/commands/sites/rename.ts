import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { resolveSiteName, loadProjectConfig, saveProjectConfig } from "../../utils/site-config.ts"

export async function sitesRenameCommand(
  name: string | undefined,
  newName: string,
  options: { json?: boolean } = {}
): Promise<void> {
  const spinner = ora()

  try {
    const server = getCurrentServer()
    const resolved = resolveSiteName(name, server?.domain ?? "")
    if (!resolved) {
      throw new ValidationError("Site name required. Pass it as an argument or run from a directory with .siteio/config.json")
    }
    if (!name) {
      console.error(chalk.dim(`Using site '${resolved}' from .siteio/config.json`))
    }

    if (!/^[a-z0-9-]+$/.test(newName)) {
      throw new ValidationError("New name must contain only lowercase letters, numbers, and hyphens")
    }
    if (newName === resolved) {
      throw new ValidationError("New name is the same as the current one")
    }

    spinner.start(`Renaming ${resolved} → ${newName}`)

    const client = new SiteioClient()
    const site = await client.renameSite(resolved, newName)

    spinner.succeed(`Renamed ${resolved} → ${newName}`)

    // Update .siteio/config.json if it references the old name
    const localConfig = loadProjectConfig()
    if (localConfig && localConfig.site === resolved) {
      localConfig.site = newName
      saveProjectConfig(localConfig)
      if (!options.json) {
        console.error(chalk.dim("Updated .siteio/config.json"))
      }
    }

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: site }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`Site renamed to ${chalk.bold(newName)}`))
      console.log(`  ${chalk.cyan(site.url)}`)
      console.log("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
