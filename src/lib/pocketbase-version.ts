// Single source of truth for the pinned PocketBase version. The locally
// downloaded dev binary and newly created sites use this exact version.
export const POCKETBASE_VERSION = "0.40.4"

// Each site runs the image of its OWN recorded version (Site.pocketbaseVersion),
// not the pin: pb_data migrations are one-way, so a site only moves to a newer
// PocketBase through `siteio sites upgrade` (backup first), never implicitly.
// Images are published by CI (docker/pocketbase/Dockerfile).
export function pocketbaseImage(version: string = POCKETBASE_VERSION): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid PocketBase version: ${version}`)
  return `ghcr.io/plosson/siteio-pocketbase:${version}`
}
