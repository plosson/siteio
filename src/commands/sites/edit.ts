import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { resolveSiteName } from "../../utils/site-config.ts"
import { formatSuccess, formatDim } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { openBrowser } from "../../utils/browser.ts"

interface EditOptions {
  json?: boolean
  label?: string
  revoke?: boolean
  open?: boolean
}

export async function sitesEditCommand(name: string | undefined, options: EditOptions = {}): Promise<void> {
  try {
    const server = getCurrentServer()
    const resolved = resolveSiteName(name, server?.domain ?? "")
    if (!resolved) throw new ValidationError("Site name required (argument or .siteio/config.json)")

    const client = new SiteioClient()

    if (options.revoke) {
      const revoked = await client.revokeEditLinks(resolved)
      if (options.json) {
        console.log(JSON.stringify({ success: true, data: { revoked } }, null, 2))
      } else if (revoked === 0) {
        console.error(formatDim(`No active edit links for site '${resolved}'.`))
      } else {
        console.error(formatSuccess(`Revoked ${revoked} edit link${revoked === 1 ? "" : "s"} for '${resolved}'`))
      }
      process.exit(0)
    }

    const created = await client.createEditLink(resolved, { label: options.label })

    if (options.open) openBrowser(created.url)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: created }, null, 2))
    } else {
      const mins = Math.max(1, Math.round((Date.parse(created.expiresAt) - Date.now()) / 60_000))
      console.error(formatSuccess(`Live editor link for site '${resolved}'`))
      console.error("")
      console.error(`    ${chalk.cyan(created.url)}`)
      console.error("")
      console.error(formatDim(`  Open it to chat with an AI editor on the site itself — changes go live immediately.`))
      console.error(formatDim(`  One-time link · expires in ~${mins} min · revoke anytime with 'siteio sites edit --revoke'.`))
      console.error("")
      console.error(chalk.yellow("  ! Shown only once. In Phase 1 this is for the site owner — do not hand it to a client yet."))
    }
    process.exit(0)
  } catch (err) {
    handleError(err)
  }
}
