import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { resolveSiteName } from "../../utils/site-config.ts"
import { formatSuccess, formatTable, formatDim } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

interface ShareOptions {
  json?: boolean
  name?: string
  label?: string
  allowBackend?: boolean
}

export async function sitesShareCommand(name: string | undefined, options: ShareOptions = {}): Promise<void> {
  try {
    const server = getCurrentServer()
    const resolved = resolveSiteName(name, server?.domain ?? "")
    if (!resolved) throw new ValidationError("Site name required (argument or .siteio/config.json)")

    const created = await new SiteioClient().createGrant(resolved, {
      allowBackend: options.allowBackend,
      label: options.label,
    })

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: created }, null, 2))
    } else {
      console.error(formatSuccess(`Share access created for site '${resolved}'`))
      console.error("")
      console.error(chalk.bold("  For coding agents (Codex, Claude Code, Cursor) — the siteio CLI:"))
      console.error(`    ${chalk.cyan(`siteio login -t ${created.cliToken}`)}`)
      console.error(formatDim(`    then: siteio sites download -n ${resolved} ./${resolved} && (edit) && siteio sites deploy`))
      console.error("")
      console.error(chalk.bold("  For claude.ai / Claude Desktop — an MCP connector:"))
      console.error(`    URL:  ${chalk.cyan(created.url)}`)
      console.error(`    Code: ${chalk.bold(created.code)}   ${chalk.dim("(paste when the connector asks to authorize)")}`)
      console.error("")
      console.error(
        formatDim(
          `  Access stays active until revoked` +
            (created.grant.allowBackend ? " · backend edits allowed" : " · web files only")
        )
      )
      console.error("")
      console.error(chalk.yellow("  ! Shown only once. Copy it now. Revoke anytime with 'siteio sites share revoke'."))
    }
    process.exit(0)
  } catch (err) {
    handleError(err)
  }
}

export async function sitesShareListCommand(name: string | undefined, options: ShareOptions = {}): Promise<void> {
  try {
    const server = getCurrentServer()
    const resolved = resolveSiteName(name, server?.domain ?? "")
    if (!resolved) throw new ValidationError("Site name required (argument or .siteio/config.json)")

    const grants = await new SiteioClient().listGrants(resolved)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: grants }, null, 2))
    } else if (grants.length === 0) {
      console.error(formatDim(`No share links for site '${resolved}'.`))
    } else {
      const rows = grants.map((g) => [
        g.id,
        g.active ? chalk.green("active") : chalk.dim("revoked"),
        g.allowBackend ? "backend" : "web",
        g.lastUsedAt ? new Date(g.lastUsedAt).toLocaleString() : chalk.dim("never"),
        g.label || chalk.dim("-"),
      ])
      console.error(formatTable(["ID", "STATUS", "SCOPE", "LAST USED", "LABEL"], rows))
    }
    process.exit(0)
  } catch (err) {
    handleError(err)
  }
}

export async function sitesShareRevokeCommand(
  id: string,
  options: ShareOptions = {}
): Promise<void> {
  try {
    const server = getCurrentServer()
    const resolved = resolveSiteName(options.name, server?.domain ?? "")
    if (!resolved) throw new ValidationError("Site name required (--name or .siteio/config.json)")

    await new SiteioClient().revokeGrant(resolved, id)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { revoked: true, id } }, null, 2))
    } else {
      console.error(formatSuccess(`Revoked share link ${id}`))
    }
    process.exit(0)
  } catch (err) {
    handleError(err)
  }
}
