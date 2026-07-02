import { existsSync, mkdirSync, rmSync, readdirSync } from "fs"
import { join, resolve } from "path"
import { tmpdir } from "os"
import ora from "ora"
import chalk from "chalk"
import { unzipSync } from "fflate"
import syncDirectory from "sync-directory"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { saveProjectConfig } from "../../utils/site-config.ts"
import { formatSuccess, formatBytes } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { resolvePocketName } from "../../utils/site-config.ts"
import { POCKETBASE_VERSION } from "../../lib/pocketbase-version.ts"
import { toLocalPath } from "../../lib/pocket-layout.ts"

export async function pocketDownloadCommand(
  outputFolder: string,
  options: { name?: string; yes?: boolean; json?: boolean }
): Promise<void> {
  const spinner = ora()
  const tempDir = join(tmpdir(), `siteio-pocket-download-${Date.now()}`)

  try {
    const server = getCurrentServer()
    const name = resolvePocketName(options.name, server?.domain ?? "")
    if (!name) {
      throw new ValidationError("Pocket name required. Use -n <name> or run from a directory with .siteio/config.json")
    }
    if (!options.name) {
      console.error(chalk.dim(`Using pocket '${name}' from .siteio/config.json`))
    }

    const outputPath = resolve(outputFolder)

    // Guard against clobbering a non-empty folder unless -y is given.
    if (!options.yes && existsSync(outputPath)) {
      if (outputPath !== resolve(".")) {
        throw new ValidationError(`Output folder already exists: ${outputPath}\nUse -y to overwrite.`)
      }
      if (readdirSync(outputPath).length > 0) {
        throw new ValidationError(`Output folder is not empty: ${outputPath}\nUse -y to overwrite.`)
      }
    }

    console.error(chalk.cyan(`> Downloading pocket ${name} to ${outputFolder}`))

    const client = new SiteioClient()

    // Fetch the code zip and the pocketbaseVersion (for the regenerated config)
    // concurrently — the two round-trips are independent.
    spinner.start("Downloading")
    const [zipData, pbVersion] = await Promise.all([
      client.downloadPocket(name),
      client.getPocket(name).then((p) => p.pocketbaseVersion).catch(() => POCKETBASE_VERSION),
    ])
    spinner.succeed(`Downloaded ${formatBytes(zipData.length)}`)

    // Extract to a temp dir first, translating the server layout back to the
    // local project layout as we go.
    spinner.start("Extracting")
    const files = unzipSync(zipData)
    let fileCount = 0

    mkdirSync(tempDir, { recursive: true })
    for (const [entry, data] of Object.entries(files)) {
      if (entry.endsWith("/")) continue // skip directory records
      const filePath = join(tempDir, toLocalPath(entry))
      mkdirSync(join(filePath, ".."), { recursive: true })
      await Bun.write(filePath, data)
      fileCount++
    }
    spinner.succeed(`Extracted ${fileCount} files`)

    // Regenerate the local-only .siteio/config.json (never shipped to the server).
    saveProjectConfig({ pocket: name, domain: server?.domain ?? "", pocketbaseVersion: pbVersion }, tempDir)

    // Sync to the output directory. Preserve any local .siteio/pb_data (dev DB)
    // that the download never carries, so refreshing a project can't wipe it.
    spinner.start("Syncing to output folder")
    mkdirSync(outputPath, { recursive: true })
    syncDirectory(tempDir, outputPath, { deleteOrphaned: true, exclude: [/(^|[\/\\])\.siteio[\/\\]pb_data([\/\\]|$)/] })
    spinner.succeed("Synced to output folder")

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { pocket: name, path: outputPath, files: fileCount } }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess("Pocket downloaded successfully!"))
      console.log("")
      console.log(`  Path: ${chalk.cyan(outputPath)}`)
      console.log(`  Files: ${fileCount}`)
      console.log("")
      console.log(chalk.dim("  Note: the server database (pb_data) stays on the server and is not downloaded."))
      console.log("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  } finally {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }
}
