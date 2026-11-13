import chalk from "chalk"
import { existsSync } from "fs"
import { resolve } from "path"
import { DEV_SUPERUSER_EMAIL, DEV_SUPERUSER_PASSWORD, runPocketbaseDev } from "../../lib/pocketbase-dev.ts"
import { POCKETBASE_VERSION } from "../../lib/pocketbase-version.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export async function sitesDevCommand(folder: string | undefined, options: { port?: number } = {}): Promise<void> {
  try {
    const dir = resolve(folder || ".")
    if (!existsSync(dir)) throw new ValidationError(`Folder not found: ${dir}`)

    const version = POCKETBASE_VERSION
    const port = options.port || 8090
    const http = `127.0.0.1:${port}`

    console.error(chalk.cyan(`> Starting PocketBase ${version} at http://${http}`))
    console.error(chalk.dim("  Serving this folder + /api backend. Press Ctrl+C to stop."))
    console.error(chalk.dim(`  Admin UI: http://${http}/_/  (${DEV_SUPERUSER_EMAIL} / ${DEV_SUPERUSER_PASSWORD})`))

    // Prints the local URL to stdout so the driving agent can hit it.
    console.log(`http://${http}`)

    const code = await runPocketbaseDev(dir, http, version)
    process.exit(code)
  } catch (err) {
    handleError(err)
  }
}
