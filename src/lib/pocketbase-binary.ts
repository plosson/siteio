import { existsSync, mkdirSync, chmodSync } from "fs"
import { join, dirname } from "path"
import { homedir, platform as osPlatform, arch as osArch } from "os"
import { unzipSync } from "fflate"
import { SiteioError } from "../utils/errors.ts"
import { POCKETBASE_VERSION } from "./pocketbase-version.ts"

function osToken(plat: NodeJS.Platform): string {
  if (plat === "darwin") return "darwin"
  if (plat === "win32") return "windows"
  return "linux"
}

function archToken(architecture: string): string {
  return architecture === "arm64" ? "arm64" : "amd64"
}

export function pocketbaseAssetName(
  version: string,
  plat: NodeJS.Platform = osPlatform(),
  architecture: string = osArch()
): string {
  return `pocketbase_${version}_${osToken(plat)}_${archToken(architecture)}.zip`
}

export function pocketbaseDownloadUrl(
  version: string,
  plat: NodeJS.Platform = osPlatform(),
  architecture: string = osArch()
): string {
  return `https://github.com/pocketbase/pocketbase/releases/download/v${version}/${pocketbaseAssetName(version, plat, architecture)}`
}

export function pocketbaseCachePath(version: string, plat: NodeJS.Platform = osPlatform()): string {
  const exe = plat === "win32" ? "pocketbase.exe" : "pocketbase"
  return join(homedir(), ".siteio", "bin", `pocketbase-${version}`, exe)
}

// Ensure the pinned PocketBase binary is present locally, downloading it once.
// Returns the absolute path to the executable.
export async function ensurePocketbaseBinary(version: string = POCKETBASE_VERSION): Promise<string> {
  const dest = pocketbaseCachePath(version)
  if (existsSync(dest)) return dest

  const url = pocketbaseDownloadUrl(version)
  const res = await fetch(url, { headers: { "User-Agent": "siteio" } })
  if (!res.ok) {
    throw new SiteioError(`Failed to download PocketBase ${version} (${res.status}) from ${url}`)
  }

  const zip = new Uint8Array(await res.arrayBuffer())
  const files = unzipSync(zip)
  const exeName = osPlatform() === "win32" ? "pocketbase.exe" : "pocketbase"
  const bin = files[exeName]
  if (!bin) {
    throw new SiteioError(`PocketBase archive did not contain '${exeName}' (found: ${Object.keys(files).join(", ")})`)
  }

  mkdirSync(dirname(dest), { recursive: true })
  await Bun.write(dest, bin)
  chmodSync(dest, 0o755)
  return dest
}
