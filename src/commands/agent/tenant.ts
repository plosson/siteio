import chalk from "chalk"
import { loadAgentConfig, updateAgentConfig } from "../../config/agent.ts"
import { SiteStorage } from "../../lib/agent/storage.ts"
import { AppStorage } from "../../lib/agent/app-storage.ts"
import { TenantRegistry, tenantSlug } from "../../lib/agent/tenants.ts"
import { encodeToken, generateApiKey } from "../../utils/token.ts"
import { formatError, formatSuccess } from "../../utils/output.ts"

// On-box management of tenants: extra base domains, each with its own API key
// that sees only its own sites. The running agent picks changes up on restart.

function getDataDir(): string {
  return process.env.SITEIO_DATA_DIR || "/data"
}

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

export async function addTenantCommand(rawDomain: string, options: { json?: boolean }): Promise<void> {
  const dataDir = getDataDir()
  const domain = rawDomain.trim().toLowerCase()
  const { tenants, registry } = load(dataDir)

  const reason = registry.checkNewTenant(domain)
  if (reason) fail(reason)

  // Its hostnames must be free: no site or app may already use the domain or
  // a subdomain of it as a custom domain.
  const taken = (d: string) => d === domain || d.endsWith(`.${domain}`)
  for (const site of new SiteStorage(dataDir).list()) {
    if (site.domains.some(taken)) fail(`Site '${site.name}' already uses a domain under '${domain}'`)
  }
  for (const app of new AppStorage(dataDir).list()) {
    if (app.domains.some(taken)) fail(`App '${app.name}' already uses a domain under '${domain}'`)
  }

  // Existing keys already ending in this tenant's slug would be captured by it.
  const suffix = `--${tenantSlug(domain)}`
  for (const site of new SiteStorage(dataDir).list()) {
    if (site.name.endsWith(suffix)) fail(`Site '${site.name}' would be captured by tenant '${domain}'`)
  }
  for (const app of new AppStorage(dataDir).list()) {
    if (app.name.endsWith(suffix)) fail(`App '${app.name}' would be captured by tenant '${domain}'`)
  }

  const tenant = { domain, apiKey: generateApiKey(), createdAt: new Date().toISOString() }
  updateAgentConfig(dataDir, { tenants: [...tenants, tenant] })

  const apiUrl = `https://api.${domain}`
  const token = encodeToken(apiUrl, tenant.apiKey)
  if (options.json) {
    console.log(JSON.stringify({ domain, apiUrl, apiKey: tenant.apiKey, token }, null, 2))
    return
  }
  console.error(formatSuccess(`Tenant '${domain}' added`))
  console.error("")
  console.error(`  1. Point DNS: *.${domain} → this server's IP`)
  console.error("  2. Restart the agent: siteio agent restart")
  console.error("  3. Send this login command to the tenant:")
  console.error("")
  console.error(`     siteio login -t ${token}`)
}

export async function listTenantsCommand(options: { json?: boolean }): Promise<void> {
  const { tenants, registry } = load(getDataDir())
  const sites = new SiteStorage(getDataDir()).list()
  const rows = tenants.map((t) => ({
    domain: t.domain,
    createdAt: t.createdAt,
    sites: sites.filter((s) => registry.ownerOf(s.name)?.domain === t.domain).length,
  }))
  if (options.json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  if (rows.length === 0) {
    console.error(chalk.gray("No tenants. Add one with: siteio agent tenant add <domain>"))
    return
  }
  for (const r of rows) console.error(`  ${r.domain}  ${chalk.gray(`${r.sites} site(s), added ${r.createdAt}`)}`)
}

export async function removeTenantCommand(rawDomain: string, options: { json?: boolean }): Promise<void> {
  const dataDir = getDataDir()
  const domain = rawDomain.trim().toLowerCase()
  const { tenants, registry } = load(dataDir)
  if (!tenants.some((t) => t.domain === domain)) fail(`No tenant '${domain}'`)

  const owned = new SiteStorage(dataDir).list().filter((s) => registry.ownerOf(s.name)?.domain === domain)
  if (owned.length > 0) {
    fail(`Tenant '${domain}' still has ${owned.length} site(s): ${owned.map((s) => s.name).join(", ")}. Delete them first.`)
  }

  updateAgentConfig(dataDir, { tenants: tenants.filter((t) => t.domain !== domain) })
  if (options.json) {
    console.log(JSON.stringify({ removed: domain }))
    return
  }
  console.error(formatSuccess(`Tenant '${domain}' removed — restart the agent: siteio agent restart`))
}
