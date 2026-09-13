import { join } from "path"
import type { App } from "../../types"
import { APP_ROUTER_PRIORITY } from "./traefik"

/**
 * Generates the YAML content of docker-compose.siteio.yml, the siteio-owned
 * override file merged on top of the user's base compose file. Adds:
 *   - siteio-network attachment on the primary service
 *   - Traefik labels for routing/TLS/OAuth
 *   - env vars set via `apps set` (primary-service-only)
 *   - volumes from app.volumes (primary-service-only)
 *
 * All scalar values are double-quoted so tokens like backticks, braces, and
 * equals signs survive YAML parsing intact. Keys are plain (identifier-safe).
 *
 * `env` is the resolved environment (plain vars plus decrypted secrets, see
 * AppStorage.resolveEnv) — required, so a caller cannot quietly bring the
 * project up with the secrets missing. Compose needs the values on disk, so
 * unlike the single-container path the override file holds them in the clear;
 * it is written 0600, the same protection `docker inspect` already offers on
 * the host.
 */
export function buildOverride(
  app: App,
  dataDir: string,
  env: Record<string, string>
): string {
  if (!app.compose) {
    throw new Error(`buildOverride called on non-compose app '${app.name}'`)
  }

  const primary = app.compose.primaryService
  const containerName = `siteio-${app.name}`
  const labels = buildTraefikLabelsForCompose(app, containerName)

  const envLines =
    Object.keys(env).length > 0
      ? [
          "    environment:",
          ...Object.entries(env).map(
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
    // Apps own their whole host: outrank the agent's reserved-path MCP router.
    [`traefik.http.routers.${containerName}.priority`]: String(APP_ROUTER_PRIORITY),
    [`traefik.http.services.${containerName}.loadbalancer.server.port`]: String(app.internalPort),
  }

  if (app.domains.length > 0) {
    const hostRules = app.domains.map((d) => `Host(\`${d}\`)`).join(" || ")
    labels[`traefik.http.routers.${containerName}.rule`] = hostRules
  }

  return labels
}

function yamlQuote(value: string): string {
  // Double-quoted YAML string: escape backslashes, double quotes, and control
  // characters that YAML 1.2 would otherwise fold or misinterpret.
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
  return `"${escaped}"`
}
