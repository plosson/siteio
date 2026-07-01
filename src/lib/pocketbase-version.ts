// Single source of truth for the pinned PocketBase version. The locally
// downloaded dev binary and the deployed container image MUST both use this
// exact version — divergence risks pb_data migration drift.
export const POCKETBASE_VERSION = "0.23.4"

// Published by CI (docker/pocketbase/Dockerfile) for the pinned version.
export const POCKETBASE_IMAGE = `ghcr.io/plosson/siteio-pocketbase:${POCKETBASE_VERSION}`
