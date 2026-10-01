import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { HetznerClient } from "../../lib/hetzner.ts"
import { checkDomain, getRecord, listZones, registerDomain, setupWildcardDNS } from "../../lib/cloudflare.ts"
import { ServerStateStore, type ProvisionState } from "../../commands/server/state.ts"
import { finishRegistration, provisionServer, provisionRuntime } from "../../commands/server/provision.ts"
import { destroyServer } from "../../commands/server/destroy.ts"
import { shellQuote } from "../../utils/ssh.ts"

const originalFetch = globalThis.fetch
const directories: string[] = []
afterEach(() => { globalThis.fetch = originalFetch; directories.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
function mockFetch(handler: (url: URL, init?: RequestInit) => unknown) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const result = handler(new URL(String(input)), init)
    return result instanceof Response ? result : Response.json(result)
  }) as typeof fetch
}
const cf = (result: unknown) => ({ success: true, result })
const state = (): ProvisionState => ({ version: 1, name: "box", owner: "owned", identity: "/tmp/key", email: "me@test.org", sslip: true, location: "fsn1" })
const vm = { id: 10, status: "running", name: "box", labels: { siteio: "owned" }, public_net: { ipv4: { ip: "192.0.2.1" } } }

function hetznerFixture() {
  const calls: string[] = []
  let failCreate = false
  let created = false
  const client = new HetznerClient("test-token")
  client.ensureSSHKey = async () => { calls.push("key"); return 1 }
  client.findOwned = async <T>(resource: "servers" | "firewalls"): Promise<T | undefined> => resource === "servers" && created ? vm as T : undefined
  client.createFirewall = async () => { calls.push("firewall"); return 2 }
  client.resolveType = async () => ({ id: 3, name: "cheap", architecture: "x86", prices: [], locations: [] })
  client.dockerImage = async () => 4
  client.createServer = async () => {
    calls.push("server")
    created = true
    if (failCreate) throw new Error("lost response")
    return vm
  }
  client.waitForServer = async () => vm
  client.deleteResource = async (resource) => { calls.push(`delete:${resource}`) }
  return { client, calls, loseResponse: () => { failCreate = true } }
}
function runtimeFixture() {
  let installed = false
  let failInstall = false
  const calls: string[] = []
  const runtime: typeof provisionRuntime = {
    sleep: async () => {},
    task: (_message, _done, run) => run(),
    ssh: async (_target, command) => ({
      exitCode: command.startsWith("systemctl") && !installed ? 1 : 0,
      stdout: JSON.stringify({ domain: "192-0-2-1.sslip.io", apiKey: "secret" }), stderr: "",
    }),
    install: async () => { calls.push("install"); if (failInstall) { failInstall = false; throw new Error("install failed") }; installed = true },
    login: async () => { calls.push("login") },
  }
  return { runtime, calls, failNextInstall: () => { failInstall = true } }
}

describe("Hetzner API", () => {
  test("selects cheapest available x86 type by local price from per-location availability", async () => {
    const price = (gross: string, location = "fsn1") => [{ location, price_monthly: { gross } }]
    const at = (name: string, available = true, deprecation: object | null = null) => [{ name, available, deprecation }]
    const requested: string[] = []
    mockFetch(url => {
      requested.push(url.pathname)
      return { server_types: [
        { id: 1, name: "arm", architecture: "arm", prices: price("1"), locations: at("fsn1") },
        { id: 2, name: "expensive", architecture: "x86", prices: price("12"), locations: at("fsn1") },
        { id: 3, name: "cheap", architecture: "x86", prices: price("3"), locations: at("fsn1") },
        { id: 4, name: "retired", architecture: "x86", prices: price("1"), locations: at("fsn1", true, { unavailable_after: "2026-12-01T00:00:00Z" }) },
        { id: 5, name: "sold-out", architecture: "x86", prices: price("2"), locations: at("fsn1", false) },
        { id: 6, name: "elsewhere", architecture: "x86", prices: price("1", "hel1"), locations: at("hel1") },
        { id: 7, name: "unpriced", architecture: "x86", prices: price("1", "hel1"), locations: at("fsn1") },
        { id: 8, name: "unlisted", architecture: "x86", prices: price("1") },
      ] }
    })
    expect((await new HetznerClient("token").resolveType("fsn1")).name).toBe("cheap")
    for (const name of ["sold-out", "retired", "elsewhere", "unpriced", "unlisted", "arm"]) {
      await expect(new HetznerClient("token").resolveType("fsn1", name)).rejects.toThrow("No available")
    }
    // The datacenters server_types fields were dropped on 2026-10-01; never depend on them again.
    expect(requested.every(path => path.endsWith("/server_types"))).toBe(true)
  })
  test("paginates and reuses SSH key material despite a different comment", async () => {
    let pages = 0
    mockFetch((url, init) => {
      expect(init?.method).toBe("GET")
      pages++
      return { ssh_keys: url.searchParams.get("page") === "2" ? [{ id: 9, public_key: "ssh-ed25519 AAAA old-comment" }] : [], meta: { pagination: { next_page: pages === 1 ? 2 : null } } }
    })
    expect(await new HetznerClient("token").ensureSSHKey("ssh-ed25519 AAAA new-comment", "key")).toBe(9)
    expect(pages).toBe(2)
  })
  test("creates firewall with only requested inbound TCP ports and ownership", async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body.labels).toEqual({ siteio: "owner" })
      expect(body.rules.map((r: { port: string }) => r.port)).toEqual(["22", "80", "443"])
      expect(body.rules.every((r: { direction: string; protocol: string }) => r.direction === "in" && r.protocol === "tcp")).toBe(true)
      return { firewall: { id: 8 } }
    })
    expect(await new HetznerClient("token").createFirewall("box", "owner")).toBe(8)
  })
  test("deletion tolerates missing resources but reports authorization failures", async () => {
    mockFetch(() => Response.json({ error: { message: "missing" } }, { status: 404 }))
    await new HetznerClient("token").deleteResource("servers", 1)
    mockFetch(() => Response.json({ error: { message: "forbidden" } }, { status: 403 }))
    await expect(new HetznerClient("token").deleteResource("servers", 1)).rejects.toThrow("forbidden")
  })
})

describe("Cloudflare provisioning", () => {
  test("paginates zones", async () => {
    mockFetch(url => ({ ...cf([{ id: url.searchParams.get("page"), name: "test.org" }]), result_info: { total_pages: 2 } }))
    expect((await listZones("token")).map(z => z.id)).toEqual(["1", "2"])
  })
  test("uses the VM IP, records ownership, and returns DNS IDs", async () => {
    mockFetch((url, init) => {
      if (url.pathname === "/client/v4/zones") return cf([{ id: "zone", name: "test.org" }])
      if (init?.method === "GET") return cf([])
      const body = JSON.parse(String(init?.body))
      expect(body.content).toBe("192.0.2.1")
      expect(body.comment).toBe("siteio:owned")
      expect(body.proxied).toBe(false)
      return cf({ id: "record", ...body })
    })
    const result = await setupWildcardDNS("token", "test.org", { ip: "192.0.2.1", owner: "siteio:owned" })
    expect(result.recordId).toBe("record")
    expect(result.zoneId).toBe("zone")
    expect(result.owned).toBe(true)
  })
  test("refuses conflicting DNS and does not claim existing shared DNS", async () => {
    let ip = "192.0.2.9"
    mockFetch(url => url.pathname === "/client/v4/zones" ? cf([{ id: "zone", name: "test.org" }]) : cf([{ id: "record", content: ip }]))
    await expect(setupWildcardDNS("token", "test.org", { ip: "192.0.2.1", owner: "siteio:owned" })).rejects.toThrow("refusing to overwrite")
    ip = "192.0.2.1"
    expect((await setupWildcardDNS("token", "test.org", { ip, owner: "siteio:owned" })).owned).toBe(false)
  })
  test("API envelope failures cannot be mistaken for missing DNS records", async () => {
    mockFetch(() => ({ success: false, errors: [{ message: "permission denied" }] }))
    await expect(getRecord("token", "zone", "*.test.org")).rejects.toThrow("permission denied")
  })
  test("checks availability and accepts asynchronous registration", async () => {
    mockFetch((url, init) => {
      expect(init?.method).toBe("POST")
      if (url.pathname.endsWith("domain-check")) {
        expect(JSON.parse(String(init?.body))).toEqual({ domains: ["test.org"] })
        return cf({ domains: [{ name: "test.org", registrable: true, pricing: { currency: "USD", registration_cost: "10", renewal_cost: "10" } }] })
      }
      expect(JSON.parse(String(init?.body))).toEqual({ domain_name: "test.org" })
      return Response.json(cf({ state: "in_progress", completed: false }), { status: 202 })
    })
    expect((await checkDomain("token", "account", "test.org")).registrable).toBe(true)
    expect((await registerDomain("token", "account", "test.org")).state).toBe("in_progress")
  })
  test("resume polls purchases, never POSTs them again", async () => {
    const saved: ProvisionState = { ...state(), domain: "test.org", accountId: "account", purchase: "submitted" as const }
    let calls = 0
    mockFetch((url, init) => {
      expect(init?.method).toBe("GET")
      expect(url.pathname.endsWith("registration-status")).toBe(true)
      return cf({ state: ++calls === 1 ? "in_progress" : "succeeded" })
    })
    await finishRegistration(saved, "token", () => {}, async () => {})
    expect(saved.purchase).toBe("succeeded")
    expect(calls).toBe(2)
  })
  test("registration requiring action stops immediately", async () => {
    mockFetch(() => cf({ state: "action_required", error: { message: "Configure billing" } }))
    const saved: ProvisionState = { ...state(), domain: "test.org", accountId: "account", purchase: "submitted" as const }
    await expect(finishRegistration(saved, "token", () => {}, async () => {})).rejects.toThrow("Configure billing")
    expect(saved.purchase).toBe("submitted")
  })
})

describe("resumable provisioning", () => {
  test("sslip creates, installs and logs in; retry does not recreate resources", async () => {
    mockFetch(() => ({}))
    const saved = state()
    const h = hetznerFixture(), r = runtimeFixture()
    let saves = 0
    await provisionServer(saved, () => { saves++ }, h.client, "key", undefined, r.runtime)
    await provisionServer(saved, () => { saves++ }, h.client, "key", undefined, r.runtime)
    expect(h.calls).toEqual(["key", "firewall", "server"])
    expect(r.calls).toEqual(["install", "login", "login"])
    expect(saved.domain).toBe("192-0-2-1.sslip.io")
    expect(saved.loggedIn).toBe(true)
    expect(saves).toBeGreaterThan(5)
  })
  test("lost VM response is reconciled by ownership without a second VM", async () => {
    mockFetch(() => ({}))
    const saved = state(), h = hetznerFixture(), r = runtimeFixture()
    h.loseResponse()
    await expect(provisionServer(saved, () => {}, h.client, "key", undefined, r.runtime)).rejects.toThrow("lost response")
    expect(saved.serverId).toBeUndefined()
    await provisionServer(saved, () => {}, h.client, "key", undefined, r.runtime)
    expect(h.calls.filter(c => c === "server")).toHaveLength(1)
    expect(saved.serverId).toBe(10)
  })
  test("failed install resumes on existing VM", async () => {
    mockFetch(() => ({}))
    const saved = state(), h = hetznerFixture(), r = runtimeFixture()
    r.failNextInstall()
    await expect(provisionServer(saved, () => {}, h.client, "key", undefined, r.runtime)).rejects.toThrow("install failed")
    expect(saved.installed).toBeUndefined()
    await provisionServer(saved, () => {}, h.client, "key", undefined, r.runtime)
    expect(h.calls).toEqual(["key", "firewall", "server"])
    expect(r.calls).toEqual(["install", "install", "login"])
  })
  test("destroy removes only owned DNS and never calls registrar", async () => {
    const saved = { ...state(), sslip: false, domain: "test.org", zoneId: "zone", serverId: 10, firewallId: 2 }
    const h = hetznerFixture()
    const deleted: string[] = []
    mockFetch((url, init) => {
      expect(url.pathname).not.toContain("registrar")
      if (init?.method === "DELETE") { deleted.push(url.pathname); return cf({ id: "dns" }) }
      return cf([{ id: "dns", comment: "siteio:owned", content: "192.0.2.1" }])
    })
    await destroyServer(saved, () => {}, h.client, "token")
    expect(h.calls).toEqual(["delete:servers", "delete:firewalls"])
    expect(deleted).toEqual(["/client/v4/zones/zone/dns_records/dns"])
    expect(saved.serverId).toBeUndefined()
  })
  test("destroy preserves pre-existing DNS", async () => {
    mockFetch((_url, init) => { expect(init?.method).toBe("GET"); return cf([{ id: "shared", content: "192.0.2.1" }]) })
    await destroyServer({ ...state(), sslip: false, domain: "test.org", zoneId: "zone" }, () => {}, hetznerFixture().client, "token")
  })
  test("destroy failure preserves remaining IDs for retry", async () => {
    const saved = { ...state(), serverId: 10, firewallId: 2 }
    const h = hetznerFixture()
    h.client.deleteResource = async resource => { if (resource === "firewalls") throw new Error("busy") }
    await expect(destroyServer(saved, () => {}, h.client)).rejects.toThrow("busy")
    expect(saved.serverId).toBeUndefined()
    expect(saved.firewallId).toBe(2)
    expect(saved.destroying).toBe(true)
  })
})

describe("progress output", () => {
  test("task returns the step result and rethrows the original error so resume state stays accurate", async () => {
    expect(await provisionRuntime.task("Step", "Done", async () => 42)).toBe(42)
    const original = new Error("SSH/Docker did not become ready")
    await expect(provisionRuntime.task("Step", "Done", async () => { throw original })).rejects.toBe(original)
  })
  test("a failure inside a spinner step leaves the step unsaved for resume", async () => {
    mockFetch(() => ({}))
    const saved = state(), h = hetznerFixture(), r = runtimeFixture()
    const started: string[] = []
    r.runtime.task = (message, _done, run) => { started.push(message); return run() }
    h.client.waitForServer = async () => { throw new Error("Timed out waiting for VM") }
    await expect(provisionServer(saved, () => {}, h.client, "key", undefined, r.runtime)).rejects.toThrow("Timed out waiting for VM")
    expect(saved.serverId).toBe(10)
    expect(saved.ip).toBeUndefined()
    expect(started.at(-1)).toBe("Waiting for the VM to boot")
    expect(r.calls).toEqual([])
  })
})

describe("state storage", () => {
  test("private state, corruption detection, path traversal rejection, and locking", async () => {
    const dir = mkdtempSync(join(tmpdir(), "siteio-state-")); directories.push(dir)
    const store = new ServerStateStore(dir)
    store.save(state())
    expect(store.load("box")).toEqual(state())
    expect(statSync(join(dir, "box.json")).mode & 0o777).toBe(0o600)
    expect(() => store.load("../oops")).toThrow()
    await store.locked("box", async () => { await expect(store.locked("box", async () => {})).rejects.toThrow("already being managed") })
    await store.locked("box", async () => {})
    writeFileSync(join(dir, "box.json"), "{bad")
    expect(() => store.load("box")).toThrow()
  })
  test("shell quoting keeps spaces, apostrophes and substitutions literal", () => {
    const value = "a'b $(echo unsafe); space"
    const result = Bun.spawnSync(["sh", "-c", `printf %s ${shellQuote(value)}`])
    expect(result.stdout.toString()).toBe(value)
  })
})
