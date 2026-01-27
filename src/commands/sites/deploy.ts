import { existsSync, readdirSync, statSync } from "fs"
import { join, basename, resolve } from "path"
import ora from "ora"
import chalk from "chalk"
import { zipSync } from "fflate"
import { SiteioClient } from "../../lib/client.ts"
import { formatSuccess, formatBytes } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import type { DeployOptions, SiteOAuth } from "../../types.ts"

function sanitizeSubdomain(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

async function collectFiles(dir: string, baseDir: string = dir): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {}

  const entries = readdirSync(dir)
  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const relativePath = fullPath.slice(baseDir.length + 1)
    const stat = statSync(fullPath)

    if (stat.isDirectory()) {
      // Recursively collect files from subdirectories
      const subFiles = await collectFiles(fullPath, baseDir)
      Object.assign(files, subFiles)
    } else {
      // Read file content
      const content = await Bun.file(fullPath).bytes()
      files[relativePath] = content
    }
  }

  return files
}

export async function deployCommand(folder: string, options: DeployOptions): Promise<void> {
  const spinner = ora()

  try {
    // Resolve and validate folder
    const folderPath = resolve(folder)
    if (!existsSync(folderPath)) {
      throw new ValidationError(`Folder not found: ${folderPath}`)
    }

    const stat = statSync(folderPath)
    if (!stat.isDirectory()) {
      throw new ValidationError(`Not a directory: ${folderPath}`)
    }

    // Determine subdomain
    const subdomain = options.subdomain || sanitizeSubdomain(basename(folderPath))
    if (!subdomain) {
      throw new ValidationError("Could not determine subdomain. Please specify one with --subdomain")
    }

    if (!/^[a-z0-9-]+$/.test(subdomain)) {
      throw new ValidationError("Subdomain must contain only lowercase letters, numbers, and hyphens")
    }

    if (subdomain === "api") {
      throw new ValidationError("'api' is a reserved subdomain")
    }

    console.error(chalk.cyan(`> Deploying ${folder} to ${subdomain}`))

    // Step 1: Collect and zip files
    spinner.start("Zipping files")
    const files = await collectFiles(folderPath)
    const fileCount = Object.keys(files).length

    if (fileCount === 0) {
      spinner.fail("No files found")
      throw new ValidationError("Folder is empty")
    }

    const zipData = zipSync(files, { level: 6 })
    spinner.succeed(`Zipped ${fileCount} files (${formatBytes(zipData.length)})`)

    // Step 2: Check OAuth if auth options are provided
    const client = new SiteioClient()

    let oauth: SiteOAuth | undefined
    if (options.allowedEmails || options.allowedDomain) {
      spinner.start("Checking OAuth status")
      const oauthEnabled = await client.getOAuthStatus()
      spinner.stop()

      if (!oauthEnabled) {
        console.error(chalk.red("Google authentication not configured on the server."))
        console.error("")
        console.error(chalk.yellow("Run 'siteio agent oauth' on the server to enable Google authentication."))
        console.error(chalk.yellow("Or deploy without auth options to create a public site."))
        console.error("")
        process.exit(1)
      }

      oauth = {}
      if (options.allowedEmails) {
        oauth.allowedEmails = options.allowedEmails.split(",").map((e) => e.trim().toLowerCase())
      }
      if (options.allowedDomain) {
        oauth.allowedDomain = options.allowedDomain.toLowerCase()
      }
    }

    // Step 3: Upload
    spinner.start("Uploading")

    const site = await client.deploySite(
      subdomain,
      zipData,
      (uploaded, total) => {
        const percent = Math.round((uploaded / total) * 100)
        spinner.text = `Uploading (${percent}%)`
      },
      oauth
    )
    spinner.succeed("Uploaded")

    // Step 4: Done
    console.error("")
    console.error(formatSuccess("Site deployed successfully!"))
    console.error("")
    console.error(`  URL: ${chalk.cyan(site.url)}`)
    console.error(`  Size: ${formatBytes(site.size)}`)
    if (site.oauth) {
      console.error(`  Auth: ${chalk.yellow("Google OAuth enabled")}`)
      if (site.oauth.allowedEmails) {
        console.error(`    Allowed emails: ${chalk.cyan(site.oauth.allowedEmails.join(", "))}`)
      }
      if (site.oauth.allowedDomain) {
        console.error(`    Allowed domain: ${chalk.cyan(site.oauth.allowedDomain)}`)
      }
    }
    console.error("")

    // JSON output to stdout
    const output: Record<string, unknown> = { success: true, data: site }
    console.log(JSON.stringify(output, null, 2))
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
