import { join } from "path"

// Single source of truth for how a local site project maps to the code that
// gets deployed to the server — so the forward (deploy) and reverse (download)
// translations can never drift.
//
//   local                          deployed
//   <web files at root>       <->  public/<...>
//   .siteio/pb_migrations/*   <->  pb_migrations/*
//   .siteio/pb_hooks/*        <->  pb_hooks/*
//   .siteio/{config.json,pb_data}  local-only — never travel

export const PUBLIC_DIR = "public"
export const PUBLIC_PREFIX = `${PUBLIC_DIR}/`
export const SITEIO_DIR = ".siteio"

/** Backend dirs kept under .siteio/ locally, at the code root once deployed. */
export const BACKEND_DIRS = ["pb_migrations", "pb_hooks"] as const

/** Map a deployed code zip entry back to its path in the local project. */
export function toLocalPath(entry: string): string {
  if (entry.startsWith(PUBLIC_PREFIX)) return entry.slice(PUBLIC_PREFIX.length)
  for (const dir of BACKEND_DIRS) {
    if (entry === dir || entry.startsWith(`${dir}/`)) return join(SITEIO_DIR, entry)
  }
  // Unknown top-level entry — keep it at the root rather than lose it.
  return entry
}
