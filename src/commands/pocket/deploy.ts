import { existsSync, readdirSync, statSync } from "fs"
import { join, resolve, basename } from "path"
import ora from "ora"
import chalk from "chalk"
import { zipSync } from "fflate"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer, getUsername } from "../../config/loader.ts"
import { loadProjectConfig, saveProjectConfig } from "../../utils/site-config.ts"
import { formatSuccess, formatBytes } from "../../utils/output.ts"
import { handleError, ApiError, ValidationError } from "../../utils/errors.ts"
import { POCKETBASE_VERSION } from "../../lib/pocketbase-version.ts"
import { PUBLIC_DIR, SITEIO_DIR, BACKEND_DIRS } from "../../lib/pocket-layout.ts"

// Recursively collect files from `dir` into the zip map under `prefix`.
async function addTree(dir: string, prefix: string, out: Record<string, Uint8Array>): Promise<void> {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const rel = prefix ? `${prefix}/${entry}` : entry
    if (statSync(full).isDirectory()) {
      await addTree(full, rel, out)
    } else {
      out[rel] = await Bun.file(full).bytes()
    }
  }
}

// Build the deploy artifact: web root -> public/, plus pb_migrations and
// pb_hooks. NEVER includes .siteio/pb_data or the .siteio dir wholesale.
export async function collectPocketFiles(folder: string): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {}
  // Web root = folder contents minus the .siteio plumbing dir.
  for (const entry of readdirSync(folder)) {
    if (entry === SITEIO_DIR) continue
    const full = join(folder, entry)
    if (statSync(full).isDirectory()) {
      await addTree(full, `${PUBLIC_DIR}/${entry}`, out)
    } else {
      out[`${PUBLIC_DIR}/${entry}`] = await Bun.file(full).bytes()
    }
  }
  for (const dir of BACKEND_DIRS) {
    await addTree(join(folder, SITEIO_DIR, dir), dir, out)
  }
  return out
}

export interface PocketDeployOptions {
  json?: boolean
  force?: boolean
}

export async function pocketDeployCommand(folder: string | undefined, options: PocketDeployOptions = {}): Promise<void> {
  const spinner = ora()
  try {
    const server = getCurrentServer()
    if (!server) throw new ValidationError("Not logged in. Run 'siteio login' first.")

    const folderPath = resolve(folder || ".")
    if (!existsSync(folderPath)) throw new ValidationError(`Folder not found: ${folderPath}`)

    const config = loadProjectConfig(folderPath)
    if ((config?.site || config?.app) && !config?.pocket) {
      throw new ValidationError("This directory is a site or app, not a pocket.")
    }
    const name = config?.pocket || basename(folderPath)
    if (!/^[a-z0-9-]+$/.test(name)) {
      throw new ValidationError("Pocket name must contain only lowercase letters, numbers, and hyphens")
    }

    console.error(chalk.cyan(`> Deploying pocket ${name}`))
    saveProjectConfig({ pocket: name, domain: server.domain, pocketbaseVersion: config?.pocketbaseVersion || POCKETBASE_VERSION, version: config?.version }, folderPath)

    spinner.start("Packaging")
    const files = await collectPocketFiles(folderPath)
    const fileCount = Object.keys(files).length
    if (fileCount === 0) throw new ValidationError("Nothing to deploy (folder is empty)")
    const zipData = zipSync(files, { level: 6 })
    spinner.succeed(`Packaged ${fileCount} files (${formatBytes(zipData.length)})`)

    spinner.start("Uploading")
    const client = new SiteioClient()

    // Determine expected version for optimistic concurrency control
    const expectedVersion = (!options.force && config?.version !== undefined)
      ? config.version
      : undefined

    const info = await client.deployPocket(name, zipData, {
      deployedBy: getUsername() || undefined,
      expectedVersion,
    })
    spinner.succeed("Deployed")

    // Save version to local config for future concurrency checks
    saveProjectConfig({ pocket: name, domain: server.domain, pocketbaseVersion: config?.pocketbaseVersion || POCKETBASE_VERSION, version: info.version }, folderPath)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: info }, null, 2))
    } else {
      console.error("")
      console.error(formatSuccess("Pocket deployed successfully!"))
      console.error(`  URL:   ${chalk.cyan(info.url)}`)
      console.error(`  Admin: ${chalk.cyan(info.adminUrl)} ${chalk.dim("(run 'siteio pocket admin' for credentials)")}`)
      console.error("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    if (err instanceof ApiError && err.statusCode === 409) {
      console.error(chalk.red("Deploy rejected: version conflict"))
      console.error(chalk.yellow(`  ${err.message}`))
      console.error("")
      console.error(chalk.dim("  Someone else deployed this pocket since your last push."))
      console.error(chalk.dim("  Use --force to deploy anyway."))
      process.exit(1)
    }
    handleError(err)
  }
}
