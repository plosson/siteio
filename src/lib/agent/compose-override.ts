import { join } from "path"
import type { App } from "../../types"
import { routerLabels } from "./traefik"

/**
 * Generates the YAML content of docker-compose.siteio.yml, the siteio-owned
 * override file merged on top of the user's base compose file. Adds:
 *   - siteio-network attachment on the primary service, alongside the
 *     networks it already had (see OverrideOptions.baseNetworks)
 *   - Traefik labels for routing/TLS/OAuth
 *   - env vars set via `apps set-env` (primary-service-only)
 *   - volumes from app.volumes (primary-service-only)
 *
 * All scalar values are double-quoted so tokens like backticks, braces, and
 * equals signs survive YAML parsing intact. Keys are plain (identifier-safe).
 */
export interface OverrideOptions {
  /** Hostnames Traefik routes to the primary service (custom or default). */
  domains: string[]
  /**
   * Networks the primary service is on in the base file, as resolved by
   * `docker compose config` (an implicit `default` shows up there). Compose
   * merges explicit network lists, but a service with no `networks:` key
   * loses its implicit `default` once the override lists one, cutting it off
   * from its sibling services. Re-listing them keeps the service reachable.
   */
  baseNetworks: string[]
  dataDir?: string
}

export function buildOverride(app: App, options: OverrideOptions): string {
  const { domains, baseNetworks, dataDir = "/data" } = options
  if (!app.compose) {
    throw new Error(`buildOverride called on non-compose app '${app.name}'`)
  }

  const primary = app.compose.primaryService
  const networks = [...baseNetworks.filter((n) => n !== "siteio-network"), "siteio-network"]
  const containerName = `siteio-${app.name}`
  const labels = routerLabels(containerName, domains, app.internalPort)

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
    ...networks.map((n) => `      - ${yamlQuote(n)}`),
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
