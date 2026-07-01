import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { handleError } from "../../utils/errors.ts"

export async function pocketListCommand(options: { json?: boolean } = {}): Promise<void> {
  try {
    const pockets = await new SiteioClient().listPockets()
    if (options.json) {
      console.log(JSON.stringify({ success: true, data: pockets }, null, 2))
    } else if (pockets.length === 0) {
      console.error(chalk.dim("No pockets deployed."))
    } else {
      for (const p of pockets) {
        console.error(`${chalk.bold(p.name)}  ${chalk.cyan(p.url)}  ${chalk.dim(p.status)}`)
      }
    }
    process.exit(0)
  } catch (err) { handleError(err) }
}
