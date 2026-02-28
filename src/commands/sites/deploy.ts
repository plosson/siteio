import { existsSync, readdirSync, statSync } from "fs"
import { join, basename, resolve } from "path"
import ora from "ora"
import chalk from "chalk"
import { zipSync } from "fflate"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { text, confirm } from "../../utils/prompt.ts"
import { formatSuccess, formatBytes } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { loadProjectConfig, saveProjectConfig } from "../../utils/site-config.ts"
import type { DeployOptions, SiteOAuth } from "../../types.ts"

function sanitizeSubdomain(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function generateTestSubdomain(): string {
  const randomId = Math.random().toString(36).substring(2, 8)
  return `test-${randomId}`
}

function generateTestHtml(subdomain: string): string {
  const timestamp = new Date().toISOString()
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test Site - ${subdomain}</title>
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
  <p>This is a test deployment for <strong>${subdomain}</strong></p>
  <p class="info">Deployed at: ${timestamp}</p>
</body>
</html>`
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

export async function deployCommand(folder: string | undefined, options: DeployOptions & { json?: boolean }): Promise<void> {
  const spinner = ora()

  try {
    let files: Record<string, Uint8Array>
    let subdomain: string
    let fileCount: number

    if (options.test) {
      // Test mode: generate a simple test site
      subdomain = options.subdomain || generateTestSubdomain()

      if (!/^[a-z0-9-]+$/.test(subdomain)) {
        throw new ValidationError("Subdomain must contain only lowercase letters, numbers, and hyphens")
      }

      if (subdomain === "api") {
        throw new ValidationError("'api' is a reserved subdomain")
      }

      console.error(chalk.cyan(`> Deploying test site to ${subdomain}`))

      spinner.start("Generating test site")
      const htmlContent = generateTestHtml(subdomain)
      files = {
        "index.html": new TextEncoder().encode(htmlContent),
      }
      fileCount = 1
      spinner.succeed("Generated test site")
    } else {
      // Normal mode: deploy from folder
      // Get server info first
      const server = getCurrentServer()
      if (!server) {
        throw new ValidationError("Not logged in. Run 'siteio login' first.")
      }

      // Default to current directory if no folder provided
      const folderPath = resolve(folder || ".")
      if (!existsSync(folderPath)) {
        throw new ValidationError(`Folder not found: ${folderPath}`)
      }

      const stat = statSync(folderPath)
      if (!stat.isDirectory()) {
        throw new ValidationError(`Not a directory: ${folderPath}`)
      }

      // Load or create site config
      let localConfig = loadProjectConfig(folderPath)

      if (localConfig?.site) {
        subdomain = localConfig.site

        // Warn if domain mismatch
        if (localConfig.domain !== server.domain) {
          console.error(chalk.yellow(`Warning: Config is for ${localConfig.domain}, current server is ${server.domain}`))
          const proceed = await confirm(`Deploy to ${server.domain} instead?`)
          if (!proceed) process.exit(0)
          localConfig = null
        }
      } else {
        subdomain = options.subdomain || sanitizeSubdomain(basename(folderPath))
        if (!subdomain) {
          subdomain = sanitizeSubdomain(await text("Site name"))
        }
      }

      // --subdomain overrides config
      if (options.subdomain) {
        subdomain = options.subdomain
      }

      if (!subdomain) {
        throw new ValidationError("Could not determine subdomain. Please specify one with --subdomain")
      }

      if (!/^[a-z0-9-]+$/.test(subdomain)) {
        throw new ValidationError("Subdomain must contain only lowercase letters, numbers, and hyphens")
      }

      if (subdomain === "api") {
        throw new ValidationError("'api' is a reserved subdomain")
      }

      console.error(chalk.cyan(`> Deploying ${folder || "."} to ${subdomain}`))

      // Save config (remembers site name and server for next time)
      saveProjectConfig({ site: subdomain, domain: server.domain }, folderPath)

      spinner.start("Zipping files")
      files = await collectFiles(folderPath)
      fileCount = Object.keys(files).length

      if (fileCount === 0) {
        spinner.fail("No files found")
        throw new ValidationError("Folder is empty")
      }
      spinner.succeed(`Zipped ${fileCount} files`)
    }

    const zipData = zipSync(files, { level: 6 })
    console.error(chalk.dim(`  ${fileCount} file(s), ${formatBytes(zipData.length)}`))

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
    if (options.json) {
      console.log(JSON.stringify({ success: true, data: site }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess("Site deployed successfully!"))
      console.log("")
      console.log(`  URL: ${chalk.cyan(site.url)}`)
      console.log(`  Size: ${formatBytes(site.size)}`)
      if (site.oauth) {
        console.log(`  Auth: ${chalk.yellow("Google OAuth enabled")}`)
        if (site.oauth.allowedEmails) {
          console.log(`    Allowed emails: ${chalk.cyan(site.oauth.allowedEmails.join(", "))}`)
        }
        if (site.oauth.allowedDomain) {
          console.log(`    Allowed domain: ${chalk.cyan(site.oauth.allowedDomain)}`)
        }
      }
      console.log("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
