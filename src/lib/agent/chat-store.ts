import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from "fs"
import { join } from "path"
import type { ChatMessage } from "../../types.ts"

// Per-site chat transcript persistence for the AI editor. One append-only JSON
// array per site, mirroring SiteStorage's per-site-tree convention:
//   <dataDir>/pocket-chat/<name>/messages.json
//
// 0600 throughout: a transcript can capture tool output that mentions file
// contents, and the store lives on the shared data volume — keep it owner-only.
export class ChatStore {
  private root: string

  constructor(dataDir: string) {
    this.root = join(dataDir, "pocket-chat")
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }

  private siteDir(name: string): string {
    return join(this.root, name)
  }
  private messagesPath(name: string): string {
    return join(this.siteDir(name), "messages.json")
  }

  // Full transcript, oldest first. Empty array when a site has no history.
  list(name: string): ChatMessage[] {
    const p = this.messagesPath(name)
    if (!existsSync(p)) return []
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8"))
      return Array.isArray(parsed) ? (parsed as ChatMessage[]) : []
    } catch {
      return []
    }
  }

  append(name: string, ...messages: ChatMessage[]): void {
    const dir = this.siteDir(name)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const all = [...this.list(name), ...messages]
    writeFileSync(this.messagesPath(name), JSON.stringify(all, null, 2), { mode: 0o600 })
  }

  // Replace a message in place (e.g. to attach a revert marker later). No-op if
  // the id isn't found. Returns whether a message was replaced.
  update(name: string, id: string, patch: Partial<ChatMessage>): boolean {
    const all = this.list(name)
    const idx = all.findIndex((m) => m.id === id)
    if (idx === -1) return false
    all[idx] = { ...all[idx]!, ...patch, id: all[idx]!.id, role: all[idx]!.role }
    writeFileSync(this.messagesPath(name), JSON.stringify(all, null, 2), { mode: 0o600 })
    return true
  }

  clear(name: string): void {
    const dir = this.siteDir(name)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }

  // Move a site's transcript when the site is renamed. Best-effort: a site with
  // no chat history simply has nothing to move.
  rename(oldName: string, newName: string): void {
    const from = this.siteDir(oldName)
    if (!existsSync(from)) return
    const to = this.siteDir(newName)
    cpSync(from, to, { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }
}
