import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { PUBLIC_PREFIX, BACKEND_DIRS } from "../site-layout.ts"

// The deploy surface a scoped (share-grant) deploy is allowed to change. A
// grant deploy — whether from the MCP file tools or a scoped CLI upload — is
// confined to the web root; the site's backend (pb_migrations, pb_hooks) is
// preserved from its current code so an invitee can never alter schema, hooks,
// or endanger live data. `allowBackend` (owner opt-in, `share --allow-backend`)
// lifts that: for each backend dir the invitee actually supplied, their version
// is used instead of the preserved one.
//
// Rule, per backend dir:
//   use incoming  ⟺  allowBackend AND incoming has ≥1 file under that dir
//   else          preserve the site's current copy
// So an invitee who omits a backend dir always keeps the owner's (safe default),
// and a non-allowBackend grant can never touch backend even if the upload
// contains it. Web root is always taken from the incoming files.
export function mergeScopedDeploy(opts: {
  incoming: Record<string, Uint8Array>
  currentCodePath: string
  allowBackend: boolean
}): Record<string, Uint8Array> {
  const { incoming, currentCodePath, allowBackend } = opts
  const out: Record<string, Uint8Array> = {}

  // Web root: everything under public/ from the incoming upload.
  for (const [k, v] of Object.entries(incoming)) {
    if (k === PUBLIC_PREFIX.slice(0, -1) || k.startsWith(PUBLIC_PREFIX)) out[k] = v
  }

  for (const dir of BACKEND_DIRS) {
    const incomingHasDir = Object.keys(incoming).some((k) => k === dir || k.startsWith(`${dir}/`))
    if (allowBackend && incomingHasDir) {
      for (const [k, v] of Object.entries(incoming)) {
        if (k === dir || k.startsWith(`${dir}/`)) out[k] = v
      }
    } else {
      // Preserve the site's current backend dir (if it exists on disk).
      const src = join(currentCodePath, dir)
      if (!existsSync(src)) continue
      const walk = (d: string): void => {
        for (const entry of readdirSync(d)) {
          const full = join(d, entry)
          const rel = full.slice(currentCodePath.length + 1).replace(/\\/g, "/")
          if (statSync(full).isDirectory()) walk(full)
          else out[rel] = readFileSync(full)
        }
      }
      walk(src)
    }
  }

  return out
}
