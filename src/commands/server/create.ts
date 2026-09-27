import * as p from "@clack/prompts"
import { randomUUID } from "crypto"
import { existsSync, readFileSync, readdirSync } from "fs"
import { homedir } from "os"
import { join, resolve } from "path"
import { getProviderToken } from "../../config/loader.ts"
import { CloudflareAPIError, buildCloudflareTokenUrl, checkDomain, listCloudflareAccounts, listZones, registerDomain } from "../../lib/cloudflare.ts"
import { HetznerClient } from "../../lib/hetzner.ts"
import { handleError } from "../../utils/errors.ts"
import { ServerStateStore, validateName, type ProvisionState } from "./state.ts"
import { provisionServer } from "./provision.ts"

export interface CreateOptions {
  type?: string
  location?: string
  domain?: string
  sslip?: boolean
  email?: string
  identity?: string
}

function answer<T>(value: T | symbol): T {
  if (p.isCancel(value)) throw new Error("Server creation cancelled; rerun with the same name to resume")
  return value as T
}
function interactive(): void {
  if (!process.stdin.isTTY) throw new Error("Interactive input required; provide --email and --sslip or --domain, and optionally --identity")
}
export function validateDomain(domain: string): void {
  if (domain.length > 253 || !domain.includes(".") || !domain.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error("Use a valid domain name (ASCII/punycode, without a scheme or path)")
  }
}

async function findIdentity(requested?: string): Promise<string> {
  if (requested) {
    const file = resolve(requested.startsWith("~/") ? join(homedir(), requested.slice(2)) : requested)
    if (!existsSync(file) || !existsSync(`${file}.pub`)) throw new Error(`SSH identity and public key must exist: ${file} and ${file}.pub`)
    return file
  }
  const directory = join(homedir(), ".ssh")
  const files = existsSync(directory) ? readdirSync(directory).filter(f => f.endsWith(".pub") && existsSync(join(directory, f.slice(0, -4)))) : []
  if (!files.length) throw new Error("No SSH key pair found in ~/.ssh; create one with ssh-keygen or pass --identity")
  if (files.length === 1) return join(directory, files[0]!.slice(0, -4))
  interactive()
  return answer(await p.select({ message: "SSH key to use:", options: files.map(file => ({ value: join(directory, file.slice(0, -4)), label: file.slice(0, -4) })) }))
}

async function chooseDomain(state: ProvisionState, token: string | undefined, options: CreateOptions): Promise<void> {
  if (options.sslip || (!token && !options.domain)) { state.sslip = true; return }
  if (!token) throw new Error(`Set cloudflareToken or CLOUDFLARE_API_TOKEN first. Token template: ${buildCloudflareTokenUrl()}`)
  const zones = await listZones(token)
  let domain = options.domain?.toLowerCase()
  if (!domain) {
    interactive()
    domain = answer(await p.select({ message: "Domain for this server:", options: [
      ...zones.map(zone => ({ value: zone.id, label: `${zone.name}${zone.account ? ` (${zone.account.name})` : ""}` })),
      { value: "__sslip__", label: "Use a free sslip.io address" },
      { value: "__buy__", label: "Buy a new domain" },
    ] }))
  }
  if (domain === "__sslip__") { state.sslip = true; return }
  if (domain === "__buy__") {
    domain = answer(await p.text({ message: "Domain to buy:", placeholder: "my-server.com" })).trim().toLowerCase()
  }
  const selectedZone = !options.domain ? zones.find(z => z.id === domain) : undefined
  if (selectedZone) domain = selectedZone.name
  validateDomain(domain)
  state.domain = domain
  const matchingZones = zones.filter(z => z.name === domain)
  if (!selectedZone && matchingZones.length > 1) throw new Error("Multiple accounts contain this zone; run interactively to select one")
  const zone = selectedZone || matchingZones[0]
  if (zone) { state.zoneId = zone.id; state.accountId = zone.account?.id; return }
  if (options.domain) throw new Error(`No accessible Cloudflare zone for ${domain}; run interactively to buy a domain`)
  const accounts = await listCloudflareAccounts(token)
  if (!accounts.length) throw new Error("No Cloudflare accounts accessible; grant Account Settings Read and Registrar Write")
  state.accountId = accounts.length === 1 ? accounts[0]!.id : answer(await p.select({
    message: "Cloudflare account to bill:", options: accounts.map(account => ({ value: account.id, label: account.name })),
  }))
  state.purchase = "selected"
}

async function purchaseDomain(state: ProvisionState, token: string, save: () => void): Promise<void> {
  if (state.purchase !== "selected") return
  interactive()
  const availability = await checkDomain(token, state.accountId!, state.domain!)
  if (!availability.registrable || !availability.pricing || availability.tier === "premium") {
    throw new Error(`Cannot register ${state.domain}: ${availability.reason || "premium domains or missing price are not supported"}`)
  }
  const price = availability.pricing
  p.log.info("Cloudflare requires a default payment method, registrant contact and acceptance of its Domain Registration Agreement. Auto-renew is off.")
  const confirmed = answer(await p.confirm({ message: `Buy ${state.domain} for ${price.registration_cost} ${price.currency} (renewal ${price.renewal_cost} ${price.currency})? This purchase is non-refundable.`, initialValue: false }))
  if (!confirmed) throw new Error("Domain purchase cancelled; no purchase was submitted")
  // Persist intent BEFORE the billable request. On uncertainty only poll status.
  state.purchase = "submitted"
  save()
  try {
    await registerDomain(token, state.accountId!, state.domain!)
  } catch (error) {
    // Definitive validation/auth rejection is safe to re-confirm after correcting it.
    // Timeouts, conflicts and server errors remain submitted until reconciled.
    if (error instanceof CloudflareAPIError && [400, 401, 403, 422].includes(error.status)) {
      state.purchase = "selected"
      save()
    }
    throw error
  }
}

export async function serverCreateCommand(name = "siteio", options: CreateOptions = {}): Promise<void> {
  try {
    validateName(name)
    if (options.sslip && options.domain) throw new Error("Use either --sslip or --domain")
    const hetznerToken = getProviderToken("hetznerToken")
    if (!hetznerToken) throw new Error("Set hetznerToken with siteio config set, or set HETZNER_TOKEN")
    const cloudflareToken = getProviderToken("cloudflareToken")
    const store = new ServerStateStore()
    await store.locked(name, async () => {
      let state = store.load(name)
      if (state) {
        for (const field of ["type", "location", "domain", "email"] as const) {
          if (options[field] && options[field] !== state[field]) throw new Error(`Cannot change --${field} while resuming ${name}`)
        }
        if (options.sslip && !state.sslip) throw new Error("Cannot change domain mode while resuming")
        if (options.identity && resolve(options.identity) !== state.identity) throw new Error("Cannot change SSH identity while resuming")
        p.log.info(`Resuming ${name}`)
      } else {
        let email = options.email
        if (!email) { interactive(); email = answer(await p.text({ message: "Email for Let's Encrypt:" })) }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A valid --email is required")
        state = { version: 1, name, owner: randomUUID(), location: options.location || "fsn1", type: options.type,
          email, identity: await findIdentity(options.identity), sslip: false }
        await chooseDomain(state, cloudflareToken, options)
        store.save(state)
      }
      const savedState = state
      const save = () => store.save(savedState)
      if (state.destroying) throw new Error("Finish server destroy before creating this server again")
      if (!state.sslip && !cloudflareToken) throw new Error("Cloudflare token is required to resume this server")
      const publicKey = readFileSync(`${state.identity}.pub`, "utf8").trim()
      if (!existsSync(state.identity)) throw new Error(`SSH private key is missing: ${state.identity}`)
      await purchaseDomain(state, cloudflareToken!, save)
      await provisionServer(state, save, new HetznerClient(hetznerToken), publicKey, cloudflareToken)
      p.log.success(`Server ${name} is ready at https://api.${state.domain}`)
    })
  } catch (error) { handleError(error) }
}
