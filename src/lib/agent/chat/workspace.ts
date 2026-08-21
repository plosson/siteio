import { existsSync, mkdirSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { zipSync } from "fflate"
import { PUBLIC_DIR, PUBLIC_PREFIX } from "../../site-layout.ts"
import { mergeScopedDeploy } from "../deploy-merge.ts"

// The site's editable web root, materialized flat at the workspace root so the
// agent sees a natural project (index.html at the root, not public/index.html)
// and can run build tooling on it. Backend dirs (pb_migrations, pb_hooks) are
// deliberately NOT copied in — the chat editor is content-only, and excluding
// them avoids the agent wasting turns on edits that would be discarded at
// deploy. They are re-attached untouched from the site's current code when the
// deploy zip is built.
//
// SYMLINK SAFETY (plan §7 Blocker B): we never follow symlinks. On copy-in we
// skip them; on collect-out we skip them too, so an agent that does
// `ln -s /data/agent-config.json public/x` cannot cause the controller to read
// a host file and publish it. All reads are confined to the workspace tree.

export function prepareWorkspace(codePath: string, workspaceDir: string): void {
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 })
  const publicDir = join(codePath, PUBLIC_DIR)
  if (existsSync(publicDir)) copyTreeNoSymlinks(publicDir, workspaceDir)
}

function copyTreeNoSymlinks(from: string, to: string): void {
  for (const entry of readdirSync(from)) {
    const src = join(from, entry)
    const st = lstatSync(src)
    if (st.isSymbolicLink()) continue // never follow
    const dst = join(to, entry)
    if (st.isDirectory()) {
      mkdirSync(dst, { recursive: true, mode: 0o700 })
      copyTreeNoSymlinks(src, dst)
    } else if (st.isFile()) {
      writeFileSync(dst, readFileSync(src))
    }
  }
}

// Collect the workspace web files as deployed-layout entries (public/<rel>),
// skipping symlinks and non-regular files.
export function collectWebFiles(workspaceDir: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {}
  if (!existsSync(workspaceDir)) return out
  const walk = (dir: string, relBase: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) continue // never follow — anti-exfiltration
      const rel = relBase ? `${relBase}/${entry}` : entry
      if (st.isDirectory()) walk(full, rel)
      else if (st.isFile()) out[`${PUBLIC_PREFIX}${rel}`] = readFileSync(full)
    }
  }
  walk(workspaceDir, "")
  return out
}

// Build the deploy zip: workspace web files under public/, merged with the
// site's backend dirs preserved from current code (content-only, allowBackend
// always false — matches the scoped/MCP deploy rule).
export function buildDeployZip(workspaceDir: string, codePath: string): Uint8Array {
  const incoming = collectWebFiles(workspaceDir)
  const merged = mergeScopedDeploy({ incoming, currentCodePath: codePath, allowBackend: false })
  return zipSync(merged, { level: 6 })
}

// Did the agent actually change the web root? Compares the workspace's collected
// web files against the site's current public/ (byte-for-byte). Used to skip a
// pointless redeploy on question/no-op turns.
export function hasWebChanges(workspaceDir: string, codePath: string): { changed: boolean; changedFiles: string[] } {
  const incoming = collectWebFiles(workspaceDir)
  const current = collectCurrentPublic(codePath)
  const changedFiles: string[] = []

  const keys = new Set([...Object.keys(incoming), ...Object.keys(current)])
  for (const key of keys) {
    const a = incoming[key]
    const b = current[key]
    if (!a || !b || !bytesEqual(a, b)) {
      // Report the local-style path (drop the public/ prefix) for the UI.
      changedFiles.push(key.startsWith(PUBLIC_PREFIX) ? key.slice(PUBLIC_PREFIX.length) : key)
    }
  }
  changedFiles.sort()
  return { changed: changedFiles.length > 0, changedFiles }
}

function collectCurrentPublic(codePath: string): Record<string, Uint8Array> {
  const publicDir = join(codePath, PUBLIC_DIR)
  const out: Record<string, Uint8Array> = {}
  if (!existsSync(publicDir)) return out
  const walk = (dir: string, relBase: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) continue
      const rel = relBase ? `${relBase}/${entry}` : entry
      if (st.isDirectory()) walk(full, rel)
      else if (st.isFile()) out[`${PUBLIC_PREFIX}${rel}`] = readFileSync(full)
    }
  }
  walk(publicDir, "")
  return out
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
