import chalk from "chalk"
import { getAgentDataDir, loadAgentConfig, updateAgentConfig } from "../../config/agent.ts"
import { SiteStorage } from "../../lib/agent/storage.ts"
import { AppStorage } from "../../lib/agent/app-storage.ts"
import { TenantRegistry, tenantServices } from "../../lib/agent/tenants.ts"
import type { Tenant } from "../../types.ts"
import { encodeToken, generateApiKey } from "../../utils/token.ts"
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

export async function addTenantCommand(rawDomain: string, options: { json?: boolean; apps?: boolean }): Promise<void> {
  const dataDir = getAgentDataDir()
  const domain = rawDomain.trim().toLowerCase()
  const { tenants, registry } = load(dataDir)

  const reason = registry.checkNewTenant(domain, tenantServices(new SiteStorage(dataDir), new AppStorage(dataDir)))
  if (reason) fail(reason)

  const tenant = {
    domain,
    apiKey: generateApiKey(),
    createdAt: new Date().toISOString(),
    ...(options.apps && { apps: true }),
  }
  updateAgentConfig(dataDir, { tenants: [...tenants, tenant] })

  const apiUrl = `https://api.${domain}`
  const token = encodeToken(apiUrl, tenant.apiKey)
  if (options.json) {
    console.log(JSON.stringify({ domain, apiUrl, apiKey: tenant.apiKey, token, apps: options.apps === true }, null, 2))
    return
  }
  console.error(formatSuccess(`Tenant '${domain}' added${options.apps ? " (sites and apps)" : " (sites only)"}`))
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
  const sites = new SiteStorage(dataDir).list()
  const apps = new AppStorage(dataDir).list()
  const owns = (t: Tenant) => (key: string) => registry.ownerOf(key)?.domain === t.domain
  const rows = tenants.map((t) => ({
    domain: t.domain,
    createdAt: t.createdAt,
    apps: t.apps === true,
    sites: sites.filter((s) => owns(t)(s.name)).length,
    appCount: apps.filter((a) => owns(t)(a.name)).length,
  }))
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
    console.error(`  ${r.domain}  ${chalk.gray(`${r.sites} site(s)${appsText}, added ${r.createdAt}`)}`)
  }
}

export async function removeTenantCommand(rawDomain: string, options: { json?: boolean }): Promise<void> {
  const dataDir = getAgentDataDir()
  const domain = rawDomain.trim().toLowerCase()
  const { tenants, registry } = load(dataDir)
  if (!tenants.some((t) => t.domain === domain)) fail(`No tenant '${domain}'`)

  const ownedBy = (key: string) => registry.ownerOf(key)?.domain === domain
  const owned = [
    ...new SiteStorage(dataDir).list().filter((s) => ownedBy(s.name)).map((s) => `site ${s.name}`),
    ...new AppStorage(dataDir).list().filter((a) => ownedBy(a.name)).map((a) => `app ${a.name}`),
  ]
  if (owned.length > 0) {
    fail(`Tenant '${domain}' still has ${owned.length} site(s) or app(s): ${owned.join(", ")}. Delete them first.`)
  }

  updateAgentConfig(dataDir, { tenants: tenants.filter((t) => t.domain !== domain) })
  if (options.json) {
    console.log(JSON.stringify({ removed: domain }))
    return
  }
  console.error(formatSuccess(`Tenant '${domain}' removed — restart the agent: siteio agent restart`))
}
