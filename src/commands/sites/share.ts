import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { resolveSiteName } from "../../utils/site-config.ts"
import { formatSuccess, formatTable, formatDim } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

// Parse a short duration like "30m", "24h", "7d" into milliseconds.
function parseDuration(input: string): number {
  const m = input.trim().match(/^(\d+)\s*(m|h|d)$/i)
  if (!m) throw new ValidationError(`Invalid duration '${input}'. Use e.g. 30m, 24h, or 7d.`)
  const value = parseInt(m[1]!, 10)
  const unit = m[2]!.toLowerCase()
  const factor = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000
  return value * factor
}

interface ShareOptions {
  json?: boolean
  name?: string
  deploys?: string
  expires?: string
  label?: string
}

export async function sitesShareCommand(name: string | undefined, options: ShareOptions = {}): Promise<void> {
  try {
    const server = getCurrentServer()
    const resolved = resolveSiteName(name, server?.domain ?? "")
    if (!resolved) throw new ValidationError("Site name required (argument or .siteio/config.json)")

    const maxDeploys = options.deploys !== undefined ? parseInt(options.deploys, 10) : undefined
    if (maxDeploys !== undefined && (!Number.isInteger(maxDeploys) || maxDeploys < 1)) {
      throw new ValidationError("--deploys must be a positive integer")
    }
    const expiresInMs = options.expires !== undefined ? parseDuration(options.expires) : undefined

    const created = await new SiteioClient().createGrant(resolved, {
      maxDeploys,
      expiresInMs,
      label: options.label,
    })

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: created }, null, 2))
    } else {
      console.error(formatSuccess(`Share link created for site '${resolved}'`))
      console.error("")
      console.error(`  ${chalk.cyan(created.url)}`)
      console.error("")
      console.error(formatDim("  Paste this into an MCP client (e.g. Claude Desktop, Cursor) to let"))
      console.error(formatDim("  someone edit and redeploy this site's web files."))
      console.error(
        formatDim(
          `  Budget: ${created.grant.maxDeploys} deploy(s) · Expires: ${new Date(created.grant.expiresAt).toLocaleString()}`
        )
      )
      console.error("")
      console.error(chalk.yellow("  ! This link is shown only once. Copy it now."))
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
        g.active ? chalk.green("active") : chalk.dim(g.revoked ? "revoked" : "inactive"),
        `${g.deploysUsed}/${g.maxDeploys}`,
        new Date(g.expiresAt).toLocaleString(),
        g.label || chalk.dim("-"),
      ])
      console.error(formatTable(["ID", "STATUS", "DEPLOYS", "EXPIRES", "LABEL"], rows))
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
