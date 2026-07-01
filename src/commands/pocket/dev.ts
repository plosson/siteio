import { resolve } from "path"
import { existsSync } from "fs"
import chalk from "chalk"
import { runPocketbaseDev } from "../../lib/pocketbase-dev.ts"
import { loadProjectConfig } from "../../utils/site-config.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { POCKETBASE_VERSION } from "../../lib/pocketbase-version.ts"

export async function pocketDevCommand(folder: string | undefined, options: { port?: number } = {}): Promise<void> {
  try {
    const dir = resolve(folder || ".")
    if (!existsSync(dir)) throw new ValidationError(`Folder not found: ${dir}`)

    const config = loadProjectConfig(dir)
    const version = config?.pocketbaseVersion || POCKETBASE_VERSION
    const port = options.port || 8090
    const http = `127.0.0.1:${port}`

    console.error(chalk.cyan(`> Starting PocketBase ${version} at http://${http}`))
    console.error(chalk.dim("  Serving this folder + /api backend. Press Ctrl+C to stop."))

    // Prints the local URL to stdout so the driving agent can hit it.
    console.log(`http://${http}`)

    const code = await runPocketbaseDev(dir, http, version)
    process.exit(code)
  } catch (err) {
    handleError(err)
  }
}
