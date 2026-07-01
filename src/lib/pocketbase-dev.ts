import { join } from "path"
import { ensurePocketbaseBinary } from "./pocketbase-binary.ts"

export interface DevPaths {
  publicDir: string
  migrationsDir: string
  hooksDir: string
  dataDir: string
}

// The folder root is the web root (parity with production, where the same
// files are served under /public). Backend plumbing lives under .siteio/.
export function resolveDevPaths(folder: string): DevPaths {
  return {
    publicDir: folder,
    migrationsDir: join(folder, ".siteio", "pb_migrations"),
    hooksDir: join(folder, ".siteio", "pb_hooks"),
    dataDir: join(folder, ".siteio", "pb_data"),
  }
}

export function buildDevArgs(a: DevPaths & { http: string }): string[] {
  return [
    "serve",
    `--http=${a.http}`,
    `--dir=${a.dataDir}`,
    `--publicDir=${a.publicDir}`,
    `--migrationsDir=${a.migrationsDir}`,
    `--hooksDir=${a.hooksDir}`,
  ]
}

// Ensure the binary, then spawn `pocketbase serve` inheriting stdio so the
// user (or the driving LLM) sees the local URL and logs. Resolves with the
// process exit code when the server stops.
export async function runPocketbaseDev(folder: string, http: string, version?: string): Promise<number> {
  const bin = await ensurePocketbaseBinary(version)
  const paths = resolveDevPaths(folder)
  const proc = Bun.spawn([bin, ...buildDevArgs({ ...paths, http })], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })
  return await proc.exited
}
