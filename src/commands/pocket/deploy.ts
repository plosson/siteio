import { existsSync, readdirSync, statSync } from "fs"
import { join, resolve, basename } from "path"
import ora from "ora"
import chalk from "chalk"
import { zipSync } from "fflate"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer, getUsername } from "../../config/loader.ts"
import { loadProjectConfig, saveProjectConfig } from "../../utils/site-config.ts"
import { formatSuccess, formatBytes } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { POCKETBASE_VERSION } from "../../lib/pocketbase-version.ts"

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
    if (entry === ".siteio") continue
    const full = join(folder, entry)
    if (statSync(full).isDirectory()) {
      await addTree(full, `public/${entry}`, out)
    } else {
      out[`public/${entry}`] = await Bun.file(full).bytes()
    }
  }
  await addTree(join(folder, ".siteio", "pb_migrations"), "pb_migrations", out)
  await addTree(join(folder, ".siteio", "pb_hooks"), "pb_hooks", out)
  return out
}

export interface PocketDeployOptions {
  json?: boolean
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
    saveProjectConfig({ pocket: name, domain: server.domain, pocketbaseVersion: config?.pocketbaseVersion || POCKETBASE_VERSION }, folderPath)

    spinner.start("Packaging")
    const files = await collectPocketFiles(folderPath)
    const fileCount = Object.keys(files).length
    if (fileCount === 0) throw new ValidationError("Nothing to deploy (folder is empty)")
    const zipData = zipSync(files, { level: 6 })
    spinner.succeed(`Packaged ${fileCount} files (${formatBytes(zipData.length)})`)

    spinner.start("Uploading")
    const client = new SiteioClient()
    const info = await client.deployPocket(name, zipData, {
      deployedBy: getUsername() || undefined,
    })
    spinner.succeed("Deployed")

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
    handleError(err)
  }
}
