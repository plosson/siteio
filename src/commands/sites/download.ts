import { existsSync, mkdirSync } from "fs"
import { join, resolve } from "path"
import ora from "ora"
import chalk from "chalk"
import { unzipSync } from "fflate"
import { SiteioClient } from "../../lib/client.ts"
import { formatSuccess, formatBytes } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export async function downloadCommand(
  subdomain: string,
  outputFolder: string,
  options: { json?: boolean }
): Promise<void> {
  const spinner = ora()

  try {
    const outputPath = resolve(outputFolder)

    // Check if output folder exists
    if (existsSync(outputPath)) {
      throw new ValidationError(`Output folder already exists: ${outputPath}`)
    }

    console.error(chalk.cyan(`> Downloading ${subdomain} to ${outputFolder}`))

    const client = new SiteioClient()

    // Download the zip
    spinner.start("Downloading")
    const zipData = await client.downloadSite(subdomain)
    spinner.succeed(`Downloaded ${formatBytes(zipData.length)}`)

    // Extract
    spinner.start("Extracting")
    const files = unzipSync(zipData)
    const fileCount = Object.keys(files).length

    // Create output directory
    mkdirSync(outputPath, { recursive: true })

    // Write files
    for (const [filename, data] of Object.entries(files)) {
      // Skip directories (they end with /)
      if (filename.endsWith("/")) continue

      const filePath = join(outputPath, filename)
      const dirPath = join(outputPath, filename.split("/").slice(0, -1).join("/"))

      // Ensure parent directory exists
      if (dirPath !== outputPath && !existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true })
      }

      await Bun.write(filePath, data)
    }
    spinner.succeed(`Extracted ${fileCount} files`)

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
  }
}
