import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import type { Group } from "../../types.ts"

export class GroupStorage {
  private dataDir: string
  private groupsPath: string
  private groups: Map<string, Group>

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.groupsPath = join(dataDir, "groups.json")
    this.groups = new Map()
    this.load()
  }

  private load(): void {
    if (existsSync(this.groupsPath)) {
      try {
        const data = JSON.parse(readFileSync(this.groupsPath, "utf-8")) as Group[]
        for (const group of data) {
          this.groups.set(group.name.toLowerCase(), group)
        }
      } catch {
        // Start with empty groups
      }
    }
  }

  private save(): void {
    const data = Array.from(this.groups.values())
    writeFileSync(this.groupsPath, JSON.stringify(data, null, 2))
  }

  list(): Group[] {
    return Array.from(this.groups.values())
  }

  get(name: string): Group | null {
    return this.groups.get(name.toLowerCase()) || null
  }

  create(name: string, emails: string[]): Group {
    const normalizedName = name.toLowerCase()
    if (this.groups.has(normalizedName)) {
      throw new Error(`Group '${name}' already exists`)
    }

    const group: Group = {
      name: normalizedName,
      emails: emails.map((e) => e.toLowerCase()),
    }

    this.groups.set(normalizedName, group)
    this.save()
    return group
  }

  update(name: string, emails: string[]): Group {
    const normalizedName = name.toLowerCase()
    const existing = this.groups.get(normalizedName)
    if (!existing) {
      throw new Error(`Group '${name}' not found`)
    }

    existing.emails = emails.map((e) => e.toLowerCase())
    this.save()
    return existing
  }

  addEmails(name: string, emails: string[]): Group {
    const normalizedName = name.toLowerCase()
    const existing = this.groups.get(normalizedName)
    if (!existing) {
      throw new Error(`Group '${name}' not found`)
    }

    const newEmails = emails.map((e) => e.toLowerCase())
    for (const email of newEmails) {
      if (!existing.emails.includes(email)) {
        existing.emails.push(email)
      }
    }

    this.save()
    return existing
  }

  removeEmails(name: string, emails: string[]): Group {
    const normalizedName = name.toLowerCase()
    const existing = this.groups.get(normalizedName)
    if (!existing) {
      throw new Error(`Group '${name}' not found`)
    }

    const removeEmails = emails.map((e) => e.toLowerCase())
    existing.emails = existing.emails.filter((e) => !removeEmails.includes(e))

    this.save()
    return existing
  }

  delete(name: string): void {
    const normalizedName = name.toLowerCase()
    if (!this.groups.has(normalizedName)) {
      throw new Error(`Group '${name}' not found`)
    }

    this.groups.delete(normalizedName)
    this.save()
  }

  // Resolve a list of group names to a flat list of emails
  resolveGroups(groupNames: string[]): string[] {
    const emails = new Set<string>()

    for (const name of groupNames) {
      const group = this.groups.get(name.toLowerCase())
      if (group) {
        for (const email of group.emails) {
          emails.add(email)
        }
      }
    }

    return Array.from(emails)
  }
}
