import chalk from "chalk"
import { basename, resolve } from "path"
import { getCurrentServer } from "../../config/loader.ts"
import { scaffoldApp } from "../../lib/app-scaffold.ts"
import { handleError } from "../../utils/errors.ts"
import { formatSuccess } from "../../utils/output.ts"
import { saveProjectConfig } from "../../utils/site-config.ts"

export async function appsInitCommand(folder: string | undefined, options: { json?: boolean } = {}): Promise<void> {
  try {
    const dir = resolve(folder || ".")
    const { created } = scaffoldApp(dir)
    const name = basename(dir)

    // Record the project as an app so deploy/logs/info can resolve it without args.
    const server = getCurrentServer()
    saveProjectConfig({ app: name, domain: server?.domain || "" }, dir)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { created } }, null, 2))
    } else {
      console.error(formatSuccess("App project initialized"))
      for (const f of created) console.error(`  ${chalk.dim("created")} ${f}`)
      console.error("")
      console.error(`Run ${chalk.cyan(`siteio apps create ${name} -f Dockerfile -p 80`)} to create and build it.`)
    }
    process.exit(0)
  } catch (err) {
    handleError(err)
  }
}
