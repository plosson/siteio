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
import { PUBLIC_DIR, SITEIO_DIR, BACKEND_DIRS } from "../../lib/site-layout.ts"

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
export async function collectSiteFiles(folder: string): Promise<Record<string, Uint8Array>> {
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

function generateTestName(): string {
  const randomId = Math.random().toString(36).substring(2, 8)
  return `test-${randomId}`
}

function generateTestHtml(name: string): string {
  const timestamp = new Date().toISOString()
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test Site - ${name}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 600px;
      margin: 100px auto;
      padding: 20px;
      text-align: center;
    }
    h1 { color: #333; }
    .info { color: #666; font-size: 14px; }
    .success { color: #22c55e; font-size: 48px; margin-bottom: 20px; }
  </style>
</head>
<body>
  <div class="success">✓</div>
  <h1>Test Site Deployed</h1>
  <p>This is a test deployment for <strong>${name}</strong></p>
  <p class="info">Deployed at: ${timestamp}</p>
</body>
</html>`
}

export interface SitesDeployOptions {
  json?: boolean
  force?: boolean
  name?: string
  test?: boolean
}

export async function sitesDeployCommand(folder: string | undefined, options: SitesDeployOptions = {}): Promise<void> {
  const spinner = ora()
  try {
    const server = getCurrentServer()
    if (!server) throw new ValidationError("Not logged in. Run 'siteio login' first.")

    let name: string
    let files: Record<string, Uint8Array>
    let config: ReturnType<typeof loadProjectConfig> = null
    let folderPath: string | null = null

    if (options.test) {
      // Test mode: deploy a generated throwaway page, no folder required.
      name = options.name || generateTestName()
      files = { [`${PUBLIC_DIR}/index.html`]: new TextEncoder().encode(generateTestHtml(name)) }
    } else {
      folderPath = resolve(folder || ".")
      if (!existsSync(folderPath)) throw new ValidationError(`Folder not found: ${folderPath}`)

      config = loadProjectConfig(folderPath)
      if (config?.app && !config?.site) {
        throw new ValidationError("This directory is an app, not a site. Use 'siteio apps' commands instead.")
      }
      name = options.name || config?.site || basename(folderPath)
      files = await collectSiteFiles(folderPath)
    }

    if (!/^[a-z0-9-]+$/.test(name)) {
      throw new ValidationError("Site name must contain only lowercase letters, numbers, and hyphens")
    }
    if (name === "api") throw new ValidationError("'api' is a reserved name")

    console.error(chalk.cyan(`> Deploying site ${name}`))

    const fileCount = Object.keys(files).length
    if (fileCount === 0) throw new ValidationError("Nothing to deploy (folder is empty)")

    spinner.start("Packaging")
    const zipData = zipSync(files, { level: 6 })
    spinner.succeed(`Packaged ${fileCount} files (${formatBytes(zipData.length)})`)

    const client = new SiteioClient()

    // Pre-merge agents extract this zip layout literally (public/index.html
    // as a file path instead of a web root) — refuse rather than deploy junk.
    const serverVersion = await client.getServerVersion()
    if (serverVersion === null) {
      throw new ValidationError(
        "The agent on this server is older than this CLI and does not understand the current deploy format.\n" +
        "Update it first: ssh into the server and run 'siteio update -y && siteio agent restart'."
      )
    }

    if (folderPath) {
      saveProjectConfig({ site: name, domain: server.domain, pocketbaseVersion: config?.pocketbaseVersion || POCKETBASE_VERSION, version: config?.version }, folderPath)
    }

    spinner.start("Uploading")

    // Determine expected version for optimistic concurrency control
    const expectedVersion = (!options.force && !options.test && config?.version !== undefined)
      ? config.version
      : undefined

    const info = await client.deploySite(name, zipData, {
      deployedBy: getUsername() || undefined,
      expectedVersion,
    })
    spinner.succeed("Deployed")

    // Save version to local config for future concurrency checks
    if (folderPath) {
      saveProjectConfig({ site: name, domain: server.domain, pocketbaseVersion: config?.pocketbaseVersion || POCKETBASE_VERSION, version: info.version }, folderPath)
    }

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: info }, null, 2))
    } else {
      console.error("")
      console.error(formatSuccess("Site deployed successfully!"))
      console.error(`  URL:   ${chalk.cyan(info.url)}`)
      console.error(`  Admin: ${chalk.cyan(info.adminUrl)} ${chalk.dim("(run 'siteio sites admin' for credentials)")}`)
      console.error("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    if (err instanceof ApiError && err.statusCode === 409) {
      console.error(chalk.red("Deploy rejected: version conflict"))
      console.error(chalk.yellow(`  ${err.message}`))
      console.error("")
      console.error(chalk.dim("  Someone else deployed this site since your last push."))
      console.error(chalk.dim("  Use --force to deploy anyway."))
      process.exit(1)
    }
    handleError(err)
  }
}
