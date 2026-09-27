import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "fs"
import { dirname, join } from "path"
import { getConfigPath } from "../../config/loader.ts"

export interface ProvisionState {
  version: 1
  name: string
  owner: string
  location: string
  type?: string
  identity: string
  email: string
  domain?: string
  sslip: boolean
  accountId?: string
  purchase?: "selected" | "submitted" | "succeeded"
  zoneId?: string
  dnsRecordId?: string
  dnsOwned?: boolean
  dnsReady?: boolean
  sshKeyId?: number
  firewallId?: number
  serverId?: number
  ip?: string
  installed?: boolean
  loggedIn?: boolean
  destroying?: boolean
}

export function validateName(name: string): void {
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(name)) {
    throw new Error("Server name must be 1–63 letters, digits or hyphens, starting and ending with a letter or digit")
  }
}

export class ServerStateStore {
  constructor(private directory = join(dirname(getConfigPath()), "provisioned-servers")) {}
  private path(name: string): string {
    validateName(name)
    return join(this.directory, `${name}.json`)
  }
  load(name: string): ProvisionState | undefined {
    const path = this.path(name)
    let text: string
    try { text = readFileSync(path, "utf8") } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    const state = JSON.parse(text) as ProvisionState
    if (state.version !== 1 || state.name !== name || !state.owner || !state.identity || !state.email) {
      throw new Error(`Invalid saved server state: ${path}`)
    }
    return state
  }
  save(state: ProvisionState): void {
    const path = this.path(state.name)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
    renameSync(temporary, path)
  }
  remove(name: string): void { unlinkSync(this.path(name)) }

  async locked<T>(name: string, run: () => Promise<T>): Promise<T> {
    const lock = `${this.path(name)}.lock`
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    try { writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const pid = Number(readFileSync(lock, "utf8"))
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid lock: ${lock}`)
      try { process.kill(pid, 0) } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === "ESRCH") {
          unlinkSync(lock)
          return this.locked(name, run)
        }
        throw probeError
      }
      throw new Error(`Server ${name} is already being managed by process ${pid}`)
    }
    const release = () => { try { unlinkSync(lock) } catch { /* already released */ } }
    process.once("exit", release)
    try { return await run() } finally {
      process.removeListener("exit", release)
      release()
    }
  }
}
