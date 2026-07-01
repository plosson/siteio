import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { resolvePocketName } from "../../utils/site-config.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export async function pocketLogsCommand(name: string | undefined, options: { tail?: number; json?: boolean } = {}): Promise<void> {
  try {
    const server = getCurrentServer()
    const resolved = resolvePocketName(name, server?.domain ?? "")
    if (!resolved) throw new ValidationError("Pocket name required (argument or .siteio/config.json)")
    const logs = await new SiteioClient().getPocketLogs(resolved, options.tail ?? 100)
    if (options.json) {
      console.log(JSON.stringify({ success: true, data: logs }, null, 2))
    } else {
      console.log(logs.logs)
    }
    process.exit(0)
  } catch (err) { handleError(err) }
}
