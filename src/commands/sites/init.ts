import chalk from "chalk"
import { basename, resolve } from "path"
import { getCurrentServer } from "../../config/loader.ts"
import { POCKETBASE_VERSION } from "../../lib/pocketbase-version.ts"
import { scaffoldSite } from "../../lib/site-scaffold.ts"
import { handleError } from "../../utils/errors.ts"
import { formatSuccess } from "../../utils/output.ts"
import { saveProjectConfig } from "../../utils/site-config.ts"

export async function sitesInitCommand(folder: string | undefined, options: { json?: boolean } = {}): Promise<void> {
  try {
    const dir = resolve(folder || ".")
    const { created } = scaffoldSite(dir)

    // Record the project as a site so deploy/dev can resolve it without args.
    const server = getCurrentServer()
    saveProjectConfig(
      { pocket: basename(dir), domain: server?.domain || "", pocketbaseVersion: POCKETBASE_VERSION },
      dir,
    )

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { created } }, null, 2))
    } else {
      console.error(formatSuccess("Site initialized"))
      for (const f of created) console.error(`  ${chalk.dim("created")} ${f}`)
      console.error("")
      console.error(`Run ${chalk.cyan("siteio sites dev")} to test locally (no Docker required).`)
    }
    process.exit(0)
  } catch (err) {
    handleError(err)
  }
}
