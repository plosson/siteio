import { HetznerClient, type HetznerServer } from "../../lib/hetzner.ts"
import { buildSslipDomain, setupWildcardDNS, getRegistrationStatus, listZones } from "../../lib/cloudflare.ts"
import { installAgentCommand } from "../agent/install.ts"
import { loginCommand } from "../login.ts"
import { sshExec } from "../../utils/ssh.ts"
import type { ProvisionState } from "./state.ts"

export const provisionRuntime = {
  ssh: sshExec,
  install: installAgentCommand,
  login: (apiUrl: string, apiKey: string) => loginCommand({ apiUrl, apiKey }, { exit: false }),
  sleep: (ms: number) => Bun.sleep(ms),
}

export async function finishRegistration(state: ProvisionState, token: string, save: () => void, sleep = provisionRuntime.sleep): Promise<void> {
  if (state.purchase !== "submitted") return
  for (let attempt = 0; attempt < 60; attempt++) {
    // Never resubmit a purchase whose response may have been lost.
    const status = await getRegistrationStatus(token, state.accountId!, state.domain!)
    if (status.state === "succeeded") {
      state.purchase = "succeeded"
      save()
      break
    }
    if (status.state !== "in_progress") {
      throw new Error(`Domain registration ${status.state}: ${status.error?.message || "check the Cloudflare registrations dashboard before continuing"}`)
    }
    await sleep(5000)
  }
  if (state.purchase !== "succeeded") throw new Error("Domain registration is still pending; rerun server create to check it")
}

export async function provisionServer(
  state: ProvisionState,
  save: () => void,
  hetzner: HetznerClient,
  publicKey: string,
  cloudflareToken?: string,
  runtime = provisionRuntime,
): Promise<void> {
  if (state.destroying) throw new Error("This server is being destroyed; finish server destroy first")
  if (state.purchase === "selected") throw new Error("Domain purchase must be confirmed before provisioning")
  if (state.purchase === "submitted") await finishRegistration(state, cloudflareToken!, save, runtime.sleep)
  if (!state.sslip && !state.zoneId) {
    const zone = (await listZones(cloudflareToken!)).find(z => z.name === state.domain && (!state.accountId || z.account?.id === state.accountId))
    if (!zone) throw new Error("Cloudflare zone is not available yet; rerun server create to resume")
    state.zoneId = zone.id
    save()
  }

  if (!state.sshKeyId) {
    state.sshKeyId = await hetzner.ensureSSHKey(publicKey, `siteio-${state.owner}`)
    save()
  }
  if (!state.firewallId) {
    const existing = await hetzner.findOwned<{ id: number }>("firewalls", state.owner)
    state.firewallId = existing?.id ?? await hetzner.createFirewall(`siteio-${state.name}`, state.owner)
    save()
  }
  if (!state.serverId) {
    let server = await hetzner.findOwned<HetznerServer>("servers", state.owner)
    if (!server) {
      const type = await hetzner.resolveType(state.location, state.type)
      state.type = type.name
      save()
      const image = await hetzner.dockerImage()
      server = await hetzner.createServer(state.name, state.owner, type.name, state.location, image, state.sshKeyId, state.firewallId)
    }
    state.serverId = server.id
    save()
  }
  const server = await hetzner.waitForServer(state.serverId)
  const ip = server.public_net.ipv4!.ip
  if (state.ip && state.ip !== ip) throw new Error("The saved server IP changed; inspect DNS before resuming")
  state.ip = ip
  if (state.sslip) state.domain = buildSslipDomain(ip)
  save()

  if (!state.sslip && !state.dnsReady) {
    if (!cloudflareToken) throw new Error("Cloudflare token is required to set up DNS")
    const dns = await setupWildcardDNS(cloudflareToken, state.domain!, { ip, owner: `siteio:${state.owner}`, zoneId: state.zoneId })
    state.zoneId = dns.zoneId
    state.dnsRecordId = dns.recordId
    state.dnsOwned = dns.owned
    state.dnsReady = true
    save()
  }

  console.error(`Waiting for SSH and Docker on ${ip}…`)
  const target = `root@${ip}`
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await runtime.ssh(target, "docker info >/dev/null 2>&1", state.identity)
    if (result.exitCode === 0) { ready = true; break }
    await runtime.sleep(5000)
  }
  if (!ready) throw new Error("SSH/Docker did not become ready; rerun server create to resume")

  // Recover an installation that succeeded before the local checkpoint was written.
  if (!state.installed) {
    const installed = await runtime.ssh(target, "systemctl is-active --quiet siteio-agent && cat /data/agent-config.json", state.identity)
    let matchingConfig = false
    if (installed.exitCode === 0) {
      try { matchingConfig = JSON.parse(installed.stdout).domain === state.domain } catch { /* install below */ }
    }
    if (!matchingConfig) await runtime.install(target, { domain: state.domain, email: state.email, identity: state.identity })
    state.installed = true
    save()
  }
  const result = await runtime.ssh(target, "cat /data/agent-config.json", state.identity)
  if (result.exitCode !== 0) throw new Error("Could not read installed agent credentials over SSH")
  const config = JSON.parse(result.stdout) as { domain: string; apiKey: string }
  if (config.domain !== state.domain || !config.apiKey) throw new Error("Installed agent configuration does not match this server")
  const apiUrl = `https://api.${state.domain}`
  // TLS issuance may lag behind SSH and Docker readiness, including on sslip.io.
  let healthy = false
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`${apiUrl}/health`, { headers: { "X-API-Key": config.apiKey }, signal: AbortSignal.timeout(5000) })
      if (response.ok) { healthy = true; break }
    } catch { /* DNS/TLS may still be propagating */ }
    await runtime.sleep(5000)
  }
  if (!healthy) throw new Error("Agent HTTPS is not ready; rerun server create to finish login")
  await runtime.login(apiUrl, config.apiKey)
  state.loggedIn = true
  save()
}
