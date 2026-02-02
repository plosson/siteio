import { existsSync, mkdirSync, rmSync, readdirSync } from "fs"
import { join, resolve } from "path"
import { tmpdir } from "os"
import ora from "ora"
import chalk from "chalk"
import { unzipSync } from "fflate"
import syncDirectory from "sync-directory"
import { SiteioClient } from "../../lib/client.ts"
import { formatSuccess, formatBytes } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export async function downloadCommand(
  outputFolder: string,
  options: { subdomain?: string; yes?: boolean; json?: boolean }
): Promise<void> {
  const spinner = ora()
  const tempDir = join(tmpdir(), `siteio-download-${Date.now()}`)

  try {
    const subdomain = options.subdomain
    if (!subdomain) {
      throw new ValidationError("Subdomain is required. Use -s or --subdomain to specify.")
    }

    const outputPath = resolve(outputFolder)

    // Check if output folder exists (unless -y flag is set)
    if (!options.yes && existsSync(outputPath)) {
      const isCurrentDir = outputPath === resolve(".")
      if (!isCurrentDir) {
        throw new ValidationError(`Output folder already exists: ${outputPath}\nUse -y to overwrite.`)
      }
      // For current directory, check if it has any files
      const files = readdirSync(outputPath)
      if (files.length > 0) {
        throw new ValidationError(`Output folder is not empty: ${outputPath}\nUse -y to overwrite.`)
      }
    }

    console.error(chalk.cyan(`> Downloading ${subdomain} to ${outputFolder}`))

    const client = new SiteioClient()

    // Download the zip
    spinner.start("Downloading")
    const zipData = await client.downloadSite(subdomain)
    spinner.succeed(`Downloaded ${formatBytes(zipData.length)}`)

    // Extract to temp directory first
    spinner.start("Extracting")
    const files = unzipSync(zipData)
    const fileCount = Object.keys(files).length

    // Create temp directory
    mkdirSync(tempDir, { recursive: true })

    // Write files to temp directory
    for (const [filename, data] of Object.entries(files)) {
      // Skip directories (they end with /)
      if (filename.endsWith("/")) continue

      const filePath = join(tempDir, filename)
      const dirPath = join(tempDir, filename.split("/").slice(0, -1).join("/"))

      // Ensure parent directory exists
      if (dirPath !== tempDir && !existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true })
      }

      await Bun.write(filePath, data)
    }
    spinner.succeed(`Extracted ${fileCount} files`)

    // Sync to output directory (creates it if needed, syncs if exists)
    spinner.start("Syncing to output folder")
    mkdirSync(outputPath, { recursive: true })
    syncDirectory(tempDir, outputPath, { deleteOrphaned: true })
    spinner.succeed("Synced to output folder")

    // Done
    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { subdomain, path: outputPath, files: fileCount } }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess("Site downloaded successfully!"))
      console.log("")
      console.log(`  Path: ${chalk.cyan(outputPath)}`)
      console.log(`  Files: ${fileCount}`)
      console.log("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  } finally {
    // Clean up temp directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }
}
