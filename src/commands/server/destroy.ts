import * as p from "@clack/prompts"
import { getProviderToken, removeServer } from "../../config/loader.ts"
import { deleteRecord, getRecord } from "../../lib/cloudflare.ts"
import { HetznerClient } from "../../lib/hetzner.ts"
import { handleError } from "../../utils/errors.ts"
import { ServerStateStore, type ProvisionState } from "./state.ts"

export async function destroyServer(state: ProvisionState, save: () => void, hetzner: HetznerClient, cloudflareToken?: string): Promise<void> {
  if (!state.sslip && state.zoneId && !cloudflareToken) throw new Error("Cloudflare token is required for DNS cleanup")
  state.destroying = true
  save()
  // Reconcile resources whose create response was lost before saving their IDs.
  if (!state.serverId) {
    state.serverId = (await hetzner.findOwned<{ id: number }>("servers", state.owner))?.id
    save()
  }
  if (!state.firewallId) {
    state.firewallId = (await hetzner.findOwned<{ id: number }>("firewalls", state.owner))?.id
    save()
  }
  if (state.serverId) {
    await hetzner.deleteResource("servers", state.serverId)
    delete state.serverId
    save()
  }
  if (state.firewallId) {
    await hetzner.deleteResource("firewalls", state.firewallId)
    delete state.firewallId
    save()
  }
  if (!state.sslip && state.zoneId && state.domain) {
    const record = await getRecord(cloudflareToken!, state.zoneId, `*.${state.domain}`)
    // Shared/pre-existing records are not ours, even when they point at our VM.
    if (record && record.comment === `siteio:${state.owner}`) {
      if (state.ip && record.content !== state.ip) throw new Error("Owned DNS record was modified; inspect it before cleanup")
      await deleteRecord(cloudflareToken!, state.zoneId, record.id)
    }
    delete state.dnsRecordId
    state.dnsReady = false
    save()
  }
}

export async function serverDestroyCommand(name: string, options: { yes?: boolean } = {}): Promise<void> {
  try {
    const store = new ServerStateStore()
    await store.locked(name, async () => {
      const state = store.load(name)
      if (!state) throw new Error(`No saved server named ${name}`)
      if (!options.yes) {
        if (!process.stdin.isTTY) throw new Error("Use --yes to confirm destruction in non-interactive mode")
        const confirmed = await p.confirm({ message: `Delete VM, firewall and owned DNS for ${name}? The domain will be kept.`, initialValue: false })
        if (p.isCancel(confirmed) || !confirmed) return
      }
      const token = getProviderToken("hetznerToken")
      if (!token) throw new Error("Set hetznerToken or HETZNER_TOKEN first")
      await destroyServer(state, () => store.save(state), new HetznerClient(token), getProviderToken("cloudflareToken"))
      if (state.domain) removeServer(state.domain)
      store.remove(name)
      p.log.success(`Destroyed ${name}. Domain registration and SSH key were kept.`)
    })
  } catch (error) { handleError(error) }
}
