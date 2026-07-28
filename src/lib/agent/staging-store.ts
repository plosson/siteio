import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "fs"
import { join, resolve, sep, dirname } from "path"
import { zipSync } from "fflate"
import { ValidationError } from "../../utils/errors.ts"
import { PUBLIC_DIR } from "../site-layout.ts"
import { mergeScopedDeploy } from "./deploy-merge.ts"

// Guardrails: a single invitee-authored file and the whole staging tree are
// both size-capped so a leaked link can't fill the disk.
export const MAX_STAGING_FILE_SIZE = 25 * 1024 * 1024 // 25 MB
export const MAX_STAGING_TOTAL_SIZE = 100 * 1024 * 1024 // 100 MB

interface StagingMeta {
  seededVersion: number // site.version staging was materialized from (concurrency stamp)
}

// Per-grant server-side working copy of a site's WEB ROOT only. The invitee's
// AI reads/writes these files through the MCP tools; backend dirs
// (pb_migrations, pb_hooks) are never staged — they are re-attached untouched
// at deploy time from the site's current code. Layout:
//   <dataDir>/share-staging/<grantId>/files/**   flattened web root (index.html, ...)
//   <dataDir>/share-staging/<grantId>/meta.json  concurrency stamp
export class StagingStore {
  private root: string

  constructor(dataDir: string) {
    this.root = join(dataDir, "share-staging")
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }

  private grantDir(grantId: string): string {
    return join(this.root, grantId)
  }
  private filesDir(grantId: string): string {
    return join(this.grantDir(grantId), "files")
  }
  private metaPath(grantId: string): string {
    return join(this.grantDir(grantId), "meta.json")
  }

  isSeeded(grantId: string): boolean {
    return existsSync(this.filesDir(grantId))
  }

  // Materialize the staging copy from the site's current code (public/ subtree
  // only) and record the version it came from. No-op if already seeded.
  seed(grantId: string, codePath: string, seededVersion: number): void {
    if (this.isSeeded(grantId)) return
    const filesDir = this.filesDir(grantId)
    mkdirSync(filesDir, { recursive: true, mode: 0o700 })

    const publicDir = join(codePath, PUBLIC_DIR)
    if (existsSync(publicDir)) {
      this.copyTree(publicDir, filesDir)
    }
    this.writeMeta(grantId, { seededVersion })
  }

  private copyTree(from: string, to: string): void {
    for (const entry of readdirSync(from)) {
      const src = join(from, entry)
      const dst = join(to, entry)
      if (statSync(src).isDirectory()) {
        mkdirSync(dst, { recursive: true, mode: 0o700 })
        this.copyTree(src, dst)
      } else {
        writeFileSync(dst, readFileSync(src))
      }
    }
  }

  private writeMeta(grantId: string, meta: StagingMeta): void {
    writeFileSync(this.metaPath(grantId), JSON.stringify(meta), { mode: 0o600 })
  }

  seededVersion(grantId: string): number {
    try {
      return (JSON.parse(readFileSync(this.metaPath(grantId), "utf-8")) as StagingMeta).seededVersion
    } catch {
      return 0
    }
  }

  // After a successful deploy the invitee's edits ARE the live version, so
  // re-stamp to it — iterative deploys within the same grant don't self-conflict.
  setSeededVersion(grantId: string, version: number): void {
    this.writeMeta(grantId, { seededVersion: version })
  }

  // Resolve a client-supplied relative path to an absolute path inside the
  // staging files dir, rejecting traversal / absolute paths.
  private safePath(grantId: string, relPath: string): string {
    if (!relPath || relPath.trim() === "") throw new ValidationError("path is required")
    const normalized = relPath.replace(/\\/g, "/")
    if (normalized.startsWith("/")) throw new ValidationError(`Absolute paths are not allowed: ${relPath}`)
    const base = resolve(this.filesDir(grantId))
    const full = resolve(base, normalized)
    if (full !== base && !full.startsWith(base + sep)) {
      throw new ValidationError(`Unsafe path: ${relPath}`)
    }
    return full
  }

  listFiles(grantId: string): string[] {
    const base = this.filesDir(grantId)
    if (!existsSync(base)) return []
    const out: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else out.push(full.slice(base.length + 1).replace(/\\/g, "/"))
      }
    }
    walk(base)
    return out.sort()
  }

  readFile(grantId: string, relPath: string): { content: string; encoding: "utf8" | "base64" } {
    const full = this.safePath(grantId, relPath)
    if (!existsSync(full) || statSync(full).isDirectory()) {
      throw new ValidationError(`File not found: ${relPath}`)
    }
    const bytes = readFileSync(full)
    // Return UTF-8 text when it round-trips cleanly; otherwise base64.
    const text = bytes.toString("utf-8")
    const isText = !text.includes("�") && !bytes.includes(0)
    return isText ? { content: text, encoding: "utf8" } : { content: bytes.toString("base64"), encoding: "base64" }
  }

  writeFile(grantId: string, relPath: string, content: string, encoding: "utf8" | "base64" = "utf8"): void {
    const bytes = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf-8")
    this.writeBytes(grantId, relPath, bytes)
  }

  // Write raw bytes to a staged web file, with the same path/size hardening as
  // writeFile. Used by the server-side URL fetch (write_url).
  writeBytes(grantId: string, relPath: string, bytes: Uint8Array): void {
    if (!this.isSeeded(grantId)) mkdirSync(this.filesDir(grantId), { recursive: true, mode: 0o700 })
    const full = this.safePath(grantId, relPath)
    if (bytes.length > MAX_STAGING_FILE_SIZE) {
      throw new ValidationError(`File too large (max ${MAX_STAGING_FILE_SIZE} bytes): ${relPath}`)
    }
    const projected = this.totalSize(grantId) - this.fileSize(full) + bytes.length
    if (projected > MAX_STAGING_TOTAL_SIZE) {
      throw new ValidationError(`Staging size limit exceeded (max ${MAX_STAGING_TOTAL_SIZE} bytes)`)
    }
    mkdirSync(dirname(full), { recursive: true, mode: 0o700 })
    writeFileSync(full, bytes)
  }

  // Replace an exact snippet in a staged text file (like a code editor's
  // find-and-replace). `oldString` must match verbatim; unless `replaceAll` is
  // set it must occur exactly once, so an ambiguous edit never silently changes
  // the wrong place. Returns the number of replacements made. Refuses binary
  // files — edit those by re-uploading via writeBytes/write_url.
  editFile(grantId: string, relPath: string, oldString: string, newString: string, replaceAll = false): number {
    if (oldString === "") throw new ValidationError("old_string is required")
    if (oldString === newString) throw new ValidationError("old_string and new_string are identical")
    const full = this.safePath(grantId, relPath)
    if (!existsSync(full) || statSync(full).isDirectory()) {
      throw new ValidationError(`File not found: ${relPath}`)
    }
    const bytes = readFileSync(full)
    const text = bytes.toString("utf-8")
    if (text.includes("�") || bytes.includes(0)) {
      throw new ValidationError(`Cannot edit binary file: ${relPath}`)
    }
    const count = text.split(oldString).length - 1
    if (count === 0) throw new ValidationError(`old_string not found in ${relPath}`)
    if (count > 1 && !replaceAll) {
      throw new ValidationError(
        `old_string occurs ${count} times in ${relPath} — include more surrounding context to make it unique, or set replace_all.`
      )
    }
    const updated = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString)
    this.writeBytes(grantId, relPath, Buffer.from(updated, "utf-8"))
    return replaceAll ? count : 1
  }

  deleteFile(grantId: string, relPath: string): boolean {
    const full = this.safePath(grantId, relPath)
    if (!existsSync(full) || statSync(full).isDirectory()) return false
    rmSync(full)
    return true
  }

  private fileSize(full: string): number {
    return existsSync(full) && statSync(full).isFile() ? statSync(full).size : 0
  }

  private totalSize(grantId: string): number {
    const base = this.filesDir(grantId)
    if (!existsSync(base)) return 0
    let total = 0
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else total += statSync(full).size
      }
    }
    walk(base)
    return total
  }

  // Build the deploy zip: staging web files under public/, merged with the
  // site's backend dirs via the shared scoped-deploy rule. Staging only ever
  // holds web files, so backend is always preserved from the current code —
  // the MCP invitee can never alter backend regardless of the grant's flags.
  buildDeployZip(grantId: string, codePath: string): Uint8Array {
    const incoming: Record<string, Uint8Array> = {}
    const base = this.filesDir(grantId)
    if (existsSync(base)) {
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry)
          const rel = full.slice(base.length + 1).replace(/\\/g, "/")
          if (statSync(full).isDirectory()) walk(full)
          else incoming[`${PUBLIC_DIR}/${rel}`] = readFileSync(full)
        }
      }
      walk(base)
    }
    const merged = mergeScopedDeploy({ incoming, currentCodePath: codePath, allowBackend: false })
    return zipSync(merged, { level: 6 })
  }

  remove(grantId: string): void {
    const dir = this.grantDir(grantId)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
}
