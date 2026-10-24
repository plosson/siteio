import chalk from "chalk"
import { getAgentDataDir, loadAgentConfig, updateAgentConfig } from "../../config/agent.ts"
import { SiteStorage } from "../../lib/agent/storage.ts"
import { AppStorage } from "../../lib/agent/app-storage.ts"
import { UserStore } from "../../lib/agent/user-store.ts"
import { TenantRegistry, newTenant, tenantServices } from "../../lib/agent/tenants.ts"
import { encodeToken } from "../../utils/token.ts"
import { formatError, formatSuccess } from "../../utils/output.ts"

// On-box management of tenants: extra base domains, each with its own API key
// that sees only its own sites. The running agent picks changes up on restart.

function fail(message: string): never {
  console.error(formatError(message))
  process.exit(1)
}

function load(dataDir: string) {
  const config = loadAgentConfig(dataDir)
  if (!config.domain) fail("The agent has no domain yet — run `siteio agent start` once first")
  const tenants = config.tenants ?? []
  return { tenants, registry: new TenantRegistry(config.domain, tenants) }
}

export async function addTenantCommand(
  rawDomain: string,
  options: { json?: boolean; apps?: boolean; platformPaths?: boolean },
): Promise<void> {
  const dataDir = getAgentDataDir()
  const domain = rawDomain.trim().toLowerCase()
  const { tenants, registry } = load(dataDir)

  const reason = registry.checkNewTenant(domain, tenantServices(new SiteStorage(dataDir), new AppStorage(dataDir)))
  if (reason) fail(reason)

  const tenant = newTenant(domain, { apps: options.apps, platformPaths: options.platformPaths })
  // Users left from an earlier tenant with this domain must not come back with it.
  new UserStore(dataDir).deleteTenantUsers(domain)
  updateAgentConfig(dataDir, { tenants: [...tenants, tenant] })

  const apiUrl = `https://api.${domain}`
  const token = encodeToken(apiUrl, tenant.apiKey)
  if (options.json) {
    const platformPaths = tenant.platformPaths !== false
    console.log(JSON.stringify({ domain, apiUrl, apiKey: tenant.apiKey, token, apps: options.apps === true, platformPaths }, null, 2))
    return
  }
  console.error(formatSuccess(`Tenant '${domain}' added${options.apps ? " (sites and apps)" : " (sites only)"}`))
  if (tenant.platformPaths === false) console.error(chalk.gray("  Platform paths (/mcp, /_siteio, OAuth) are off on its sites"))
  console.error("")
  console.error(`  1. Point DNS: *.${domain} → this server's IP`)
  console.error("  2. Restart the agent: siteio agent restart")
  console.error("  3. Send this login command to the tenant:")
  console.error("")
  console.error(`     siteio login -t ${token}`)
}

export async function listTenantsCommand(options: { json?: boolean }): Promise<void> {
  const dataDir = getAgentDataDir()
  const { tenants, registry } = load(dataDir)
  const rows = registry.summaries(tenantServices(new SiteStorage(dataDir), new AppStorage(dataDir)))
  if (options.json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  if (rows.length === 0) {
    console.error(chalk.gray("No tenants. Add one with: siteio agent tenant add <domain>"))
    return
  }
  for (const r of rows) {
    const appsText = r.apps ? `, ${r.appCount} app(s)` : ", sites only"
    const pathsText = r.platformPaths ? "" : ", platform paths off"
    console.error(`  ${r.domain}  ${chalk.gray(`${r.sites} site(s)${appsText}${pathsText}, added ${r.createdAt}`)}`)
  }
}

export async function removeTenantCommand(rawDomain: string, options: { json?: boolean }): Promise<void> {
  const dataDir = getAgentDataDir()
  const domain = rawDomain.trim().toLowerCase()
  const { tenants, registry } = load(dataDir)
  if (!tenants.some((t) => t.domain === domain)) fail(`No tenant '${domain}'`)

  const blocker = registry.removalBlocker(domain, tenantServices(new SiteStorage(dataDir), new AppStorage(dataDir)))
  if (blocker) fail(blocker)

  updateAgentConfig(dataDir, { tenants: tenants.filter((t) => t.domain !== domain) })
  const removedUsers = new UserStore(dataDir).deleteTenantUsers(domain)
  if (options.json) {
    console.log(JSON.stringify({ removed: domain, removedUsers }))
    return
  }
  console.error(formatSuccess(`Tenant '${domain}' removed — restart the agent: siteio agent restart`))
  if (removedUsers.length) console.error(chalk.gray(`  Users removed: ${removedUsers.join(", ")}`))
}
