import { resolve, basename } from "path"
import chalk from "chalk"
import { scaffoldSite } from "../../lib/site-scaffold.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { saveProjectConfig } from "../../utils/site-config.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError } from "../../utils/errors.ts"

export async function sitesInitCommand(folder: string | undefined, options: { json?: boolean } = {}): Promise<void> {
  try {
    const dir = resolve(folder || ".")
    const { created } = scaffoldSite(dir)

    // Record the project as a site so deploy/info/download can resolve it without args.
    const server = getCurrentServer()
    saveProjectConfig({ site: basename(dir), domain: server?.domain || "" }, dir)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { created } }, null, 2))
    } else {
      console.error(formatSuccess("Site initialized"))
      for (const f of created) console.error(`  ${chalk.dim("created")} ${f}`)
      console.error("")
      console.error(`Run ${chalk.cyan("siteio sites deploy")} to publish it.`)
    }
    process.exit(0)
  } catch (err) {
    handleError(err)
  }
}
