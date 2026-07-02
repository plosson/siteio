import { join } from "path"
import { mkdirSync } from "fs"
import { spawnSync } from "bun"
import { ensurePocketbaseBinary } from "./pocketbase-binary.ts"

// Fixed local dev superuser. `pocket dev` provisions it so the admin dashboard
// (/_/) is usable immediately without PocketBase's first-run installer link.
// The local pb_data is a throwaway localhost sandbox that is NEVER deployed
// (deploy ships code only), so a constant default password is safe here.
export const DEV_SUPERUSER_EMAIL = "admin@siteio.me"
export const DEV_SUPERUSER_PASSWORD = "password123"

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

export function buildSuperuserArgs(email: string, password: string, dataDir: string): string[] {
  return ["superuser", "upsert", email, password, `--dir=${dataDir}`]
}

// Ensure the binary, provision the fixed local superuser, then spawn
// `pocketbase serve` inheriting stdio so the user (or the driving LLM) sees the
// local URL and logs. Resolves with the process exit code when the server stops.
export async function runPocketbaseDev(folder: string, http: string, version?: string): Promise<number> {
  const bin = await ensurePocketbaseBinary(version)
  const paths = resolveDevPaths(folder)

  // Idempotently create/refresh the default local admin before serving.
  mkdirSync(paths.dataDir, { recursive: true })
  spawnSync({
    cmd: [bin, ...buildSuperuserArgs(DEV_SUPERUSER_EMAIL, DEV_SUPERUSER_PASSWORD, paths.dataDir)],
    stdout: "ignore",
    stderr: "ignore",
  })

  const proc = Bun.spawn([bin, ...buildDevArgs({ ...paths, http })], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })
  return await proc.exited
}
