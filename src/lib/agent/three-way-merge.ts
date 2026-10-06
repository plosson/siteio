import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { spawnSync } from "bun"

// A file tree: relative path -> bytes.
export type FileTree = Record<string, Uint8Array>

export interface MergeConflict {
  path: string
  reason: "both-edited" | "binary" | "deleted-by-you" | "deleted-on-site"
}

// Labels on the conflict markers git writes into a both-edited file.
export const YOURS_LABEL = "your edits"
export const THEIRS_LABEL = "current site"
const CONFLICT_MARKERS = new RegExp(`^(<<<<<<< ${YOURS_LABEL}|>>>>>>> ${THEIRS_LABEL})$`, "m")

// Whether a file still holds unresolved conflict markers from mergeTrees.
export function hasConflictMarkers(bytes: Uint8Array): boolean {
  return !isBinary(bytes) && CONFLICT_MARKERS.test(new TextDecoder().decode(bytes))
}

function isBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0)
}

function same(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.length === b.length && a.every((v, i) => v === b[i])
}

// Line-level 3-way merge of one text file with `git merge-file`. Returns the
// merged bytes (with conflict markers when `clean` is false).
function mergeText(base: Uint8Array, theirs: Uint8Array, yours: Uint8Array): { bytes: Uint8Array; clean: boolean } {
  const dir = mkdtempSync(join(tmpdir(), "siteio-merge-"))
  try {
    const [b, t, y] = [join(dir, "base"), join(dir, "theirs"), join(dir, "yours")]
    writeFileSync(b, base)
    writeFileSync(t, theirs)
    writeFileSync(y, yours)
    const proc = spawnSync({ cmd: ["git", "merge-file", "-L", YOURS_LABEL, "-L", "start", "-L", THEIRS_LABEL, y, b, t] })
    // Exit code: 0 = clean, >0 = number of conflicts, <0 (255 here) = error.
    if (proc.exitCode === null || proc.exitCode >= 128) {
      throw new Error(`git merge-file failed: ${proc.stderr.toString().trim()}`)
    }
    return { bytes: readFileSync(y), clean: proc.exitCode === 0 }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 3-way merge of whole trees: `base` is the version both sides started from,
// `theirs` the version deployed since, `yours` the edited copy. A change made
// on one side only is taken as is. A file changed on both sides is merged
// line by line; what cannot be merged is reported as a conflict, and the
// returned tree keeps the most useful content for resolving it.
// A missing base (e.g. pruned from history) is an empty tree: deletions can
// then no longer be told apart from additions, so nothing is deleted.
export function mergeTrees(base: FileTree, theirs: FileTree, yours: FileTree): { files: FileTree; conflicts: MergeConflict[] } {
  const files: FileTree = {}
  const conflicts: MergeConflict[] = []
  const paths = new Set([...Object.keys(base), ...Object.keys(theirs), ...Object.keys(yours)])

  for (const path of [...paths].sort()) {
    const b = base[path], t = theirs[path], y = yours[path]
    let result: Uint8Array | undefined

    if (same(y, b)) result = t // only they changed it (or nobody did)
    else if (same(t, b) || same(t, y)) result = y // only you changed it, or both made the same change
    else if (y === undefined) {
      result = t
      conflicts.push({ path, reason: "deleted-by-you" })
    } else if (t === undefined) {
      result = y
      conflicts.push({ path, reason: "deleted-on-site" })
    } else if (isBinary(y) || isBinary(t) || (b !== undefined && isBinary(b))) {
      result = y
      conflicts.push({ path, reason: "binary" })
    } else {
      const merged = mergeText(b ?? new Uint8Array(), t, y)
      result = merged.bytes
      if (!merged.clean) conflicts.push({ path, reason: "both-edited" })
    }

    if (result !== undefined) files[path] = result
  }
  return { files, conflicts }
}
