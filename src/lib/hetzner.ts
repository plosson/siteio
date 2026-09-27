const API = "https://api.hetzner.cloud/v1"

export interface HetznerServer {
  id: number
  name: string
  status: string
  labels: Record<string, string>
  public_net: { ipv4: { ip: string } | null }
}
export interface ServerType {
  id: number
  name: string
  architecture: string
  deprecated?: boolean
  prices: { location: string; price_monthly: { gross: string } }[]
}
interface Action { id: number; status: string; error?: { message: string } | null }

export class HetznerError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

export class HetznerClient {
  constructor(private token: string) {}

  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status === 204) return undefined as T
    const data = await response.json() as T & { error?: { message: string } }
    if (!response.ok) throw new HetznerError(`Hetzner: ${data.error?.message || response.statusText}`, response.status)
    return data
  }

  async list<T>(resource: string, params: Record<string, string> = {}): Promise<T[]> {
    const result: T[] = []
    let page: number | null = 1
    while (page !== null) {
      const query = new URLSearchParams({ ...params, per_page: "50", page: String(page) })
      const data: Record<string, unknown> = await this.request(`/${resource}?${query}`)
      result.push(...data[resource] as T[])
      page = (data.meta as { pagination?: { next_page?: number | null } } | undefined)?.pagination?.next_page ?? null
    }
    return result
  }

  async resolveType(location: string, requested?: string): Promise<ServerType> {
    const types = await this.list<ServerType>("server_types")
    // Availability and prices are location-specific; never pin a soon-obsolete SKU.
    const datacenters = await this.list<{ location: { name: string }; server_types: { available: number[] } }>("datacenters")
    const available = new Set(datacenters.filter(d => d.location.name === location).flatMap(d => d.server_types.available))
    const candidates = types.filter(t => t.architecture === "x86" && !t.deprecated && available.has(t.id)
      && t.prices.some(p => p.location === location && Number.isFinite(Number(p.price_monthly.gross)))
      && (!requested || t.name === requested))
    candidates.sort((a, b) => Number(a.prices.find(p => p.location === location)!.price_monthly.gross)
      - Number(b.prices.find(p => p.location === location)!.price_monthly.gross))
    if (!candidates[0]) throw new Error(`No available x86 server type${requested ? ` ${requested}` : ""} in ${location}`)
    return candidates[0]
  }

  async dockerImage(): Promise<number> {
    const images = await this.list<{ id: number; name: string; architecture: string; deprecated: string | null }>("images", { type: "app", name: "docker-ce", architecture: "x86" })
    const image = images.find(i => i.name === "docker-ce" && i.architecture === "x86" && !i.deprecated)
    if (!image) throw new Error("Hetzner docker-ce x86 app image is unavailable")
    return image.id
  }

  async ensureSSHKey(publicKey: string, name: string): Promise<number> {
    const keyMaterial = (key: string) => key.trim().split(/\s+/).slice(0, 2).join(" ")
    const existing = (await this.list<{ id: number; public_key: string }>("ssh_keys"))
      .find(key => keyMaterial(key.public_key) === keyMaterial(publicKey))
    if (existing) return existing.id
    return (await this.request<{ ssh_key: { id: number } }>("/ssh_keys", "POST", {
      name, public_key: publicKey,
    })).ssh_key.id
  }

  async findOwned<T>(resource: "servers" | "firewalls", owner: string): Promise<T | undefined> {
    const items = await this.list<T>(resource, { label_selector: `siteio=${owner}` })
    if (items.length > 1) throw new Error(`Multiple ${resource} have this site's ownership label; refusing to guess`)
    return items[0]
  }

  async createFirewall(name: string, owner: string): Promise<number> {
    const result = await this.request<{ firewall: { id: number } }>("/firewalls", "POST", {
      name, labels: { siteio: owner },
      rules: ["22", "80", "443"].map(port => ({ direction: "in", protocol: "tcp", port, source_ips: ["0.0.0.0/0", "::/0"] })),
    })
    return result.firewall.id
  }

  async createServer(name: string, owner: string, type: string, location: string, image: number, key: number, firewall: number): Promise<HetznerServer> {
    const result = await this.request<{ server: HetznerServer }>("/servers", "POST", {
      name, labels: { siteio: owner }, server_type: type, location, image,
      ssh_keys: [key], firewalls: [{ firewall }],
      public_net: { enable_ipv4: true, enable_ipv6: true },
    })
    return result.server
  }

  async waitForServer(id: number): Promise<HetznerServer> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const { server } = await this.request<{ server: HetznerServer }>(`/servers/${id}`)
      if (server.status === "running" && server.public_net.ipv4?.ip) return server
      await Bun.sleep(5000)
    }
    throw new Error("Timed out waiting for VM; run server create with the same name to resume")
  }

  async deleteResource(resource: "servers" | "firewalls", id: number): Promise<void> {
    try {
      const result = await this.request<{ action?: Action } | undefined>(`/${resource}/${id}`, "DELETE")
      if (result?.action) await this.waitForAction(result.action.id)
    } catch (error) {
      if (!(error instanceof HetznerError && error.status === 404)) throw error
    }
  }

  private async waitForAction(id: number): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const { action } = await this.request<{ action: Action }>(`/actions/${id}`)
      if (action.status === "success") return
      if (action.status === "error") throw new Error(action.error?.message || "Hetzner action failed")
      await Bun.sleep(2000)
    }
    throw new Error("Timed out waiting for Hetzner deletion; run server destroy again to resume")
  }
}
