import { join } from "path"
import type { App } from "../../types"

/**
 * Generates the YAML content of docker-compose.siteio.yml, the siteio-owned
 * override file merged on top of the user's base compose file. Adds:
 *   - siteio-network attachment on the primary service
 *   - Traefik labels for routing/TLS/OAuth
 *   - env vars set via `apps set-env` (primary-service-only)
 *   - volumes from app.volumes (primary-service-only)
 *
 * All scalar values are double-quoted so tokens like backticks, braces, and
 * equals signs survive YAML parsing intact. Keys are plain (identifier-safe).
 */
export function buildOverride(app: App, dataDir: string = "/data"): string {
  if (!app.compose) {
    throw new Error(`buildOverride called on non-compose app '${app.name}'`)
  }

  const primary = app.compose.primaryService
  const containerName = `siteio-${app.name}`
  const labels = buildTraefikLabelsForCompose(app, containerName)

  const envLines =
    Object.keys(app.env).length > 0
      ? [
          "    environment:",
          ...Object.entries(app.env).map(
            ([k, v]) => `      ${k}: ${yamlQuote(v)}`
          ),
        ]
      : []

  const volumesDir = join(dataDir, "volumes", app.name)
  const volumeLines =
    app.volumes.length > 0
      ? [
          "    volumes:",
          ...app.volumes.map((vol) => {
            const hostPath = vol.name.startsWith("/")
              ? vol.name
              : join(volumesDir, vol.name)
            const ro = vol.readonly ? ":ro" : ""
            return `      - ${yamlQuote(`${hostPath}:${vol.mountPath}${ro}`)}`
          }),
        ]
      : []

  const labelLines = [
    "    labels:",
    ...Object.entries(labels).map(
      ([k, v]) => `      ${k}: ${yamlQuote(v)}`
    ),
  ]

  const lines = [
    "services:",
    `  ${primary}:`,
    "    networks:",
    "      - siteio-network",
    ...labelLines,
    ...envLines,
    ...volumeLines,
    "",
    "networks:",
    "  siteio-network:",
    "    external: true",
    "",
  ]

  return lines.join("\n")
}

/**
 * Mirror of DockerManager.buildTraefikLabels but returns the map without
 * side-effects, so it can be rendered into YAML. Kept local to avoid tight
 * coupling with the container-run codepath; label semantics must match.
 */
function buildTraefikLabelsForCompose(
  app: App,
  containerName: string
): Record<string, string> {
  const labels: Record<string, string> = {
    "traefik.enable": "true",
    "traefik.docker.network": "siteio-network",
    [`traefik.http.routers.${containerName}.entrypoints`]: "websecure",
    [`traefik.http.routers.${containerName}.tls.certresolver`]: "letsencrypt",
    [`traefik.http.services.${containerName}.loadbalancer.server.port`]: String(app.internalPort),
  }

  if (app.domains.length > 0) {
    const hostRules = app.domains.map((d) => `Host(\`${d}\`)`).join(" || ")
    labels[`traefik.http.routers.${containerName}.rule`] = hostRules
  }

  // OAuth: labels wired here once siteio enforces OAuth on container apps.
  // See TODO at src/lib/agent/docker.ts:313-314 — same gap as today.

  return labels
}

function yamlQuote(value: string): string {
  // Double-quoted YAML string: escape backslashes and double quotes only.
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  return `"${escaped}"`
}
