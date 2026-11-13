import type { App, AppInfo, ChatTarget } from "../../types.ts"
import { type EnvUpdate, publicEnv } from "./env.ts"

// The site API surface a tenant key may reach. A tenant reaches apps through
// TENANT_APP_ROUTE when Tenant.apps is set; chat, edit links and anything new
// stay operator-only unless listed here (or in MEMBER_EXTRA_ROUTE, for
// main-domain members).
export const TENANT_ROUTE =
  /^\/(agent|sites|sites\/[a-z0-9-]+(\/(logs|admin|download|thumbnail|history|rollback|upgrade|domains|env|rename|stop|start|grants|grants\/grt_[a-z0-9]+))?)$/

// The app routes a tenant allowed to run apps (Tenant.apps) may reach.
export const TENANT_APP_ROUTE = /^\/apps(\/[a-z0-9-]+(\/(deploy|stop|start|restart|logs|status|thumbnail))?)?$/

// What a main-domain member reaches beyond the tenant allowlist: the AI
// editor (chat and in-site edit links), which runs on the operator's LLM
// credential and is not offered to tenants.
export const MEMBER_EXTRA_ROUTE = /^\/sites\/[a-z0-9-]+\/(chat|chat\/stop|edit-link)$/

export const PLATFORM_PATHS_OFF = "Platform paths are off for this tenant"

// A tenant's volume is a plain name, which DockerManager keeps under
// volumes/<key>/<name>: never a host path, never a way out of that folder.
export const VOLUME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// An app's env also reaches the host `docker` process that runs it (values
// stay out of argv), so a tenant can't set what steers that process.
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
export const TENANT_DENIED_ENV = ["PATH", "HOME", "NO_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]
export const TENANT_DENIED_ENV_PREFIXES = ["LD_", "DYLD_", "DOCKER_", "BUILDKIT_", "SSL_", "GIT_"]

// Read one cookie value from a request's Cookie header (no external dep).
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie")
  if (!header) return null
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim())
      } catch {
        return null // a malformed value is no credential
      }
    }
  }
  return null
}

// Strictly shape an untrusted env update: string maps and a string array only.
// Anything else (including a client-sent `secretKeys`) is refused.
export function parseEnvUpdate(raw: unknown): EnvUpdate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const { env, secrets, unsetEnv, ...rest } = raw as Record<string, unknown>
  if (Object.keys(rest).length > 0) return null
  const isMap = (v: unknown) =>
    v === undefined ||
    (!!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string"))
  const isList = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"))
  if (!isMap(env) || !isMap(secrets) || !isList(unsetEnv)) return null
  return {
    env: env as EnvUpdate["env"],
    secrets: secrets as EnvUpdate["secrets"],
    unsetEnv: unsetEnv as string[] | undefined,
  }
}

// Coerce an untrusted picker `target` from the request body into a bounded,
// well-typed ChatTarget. The framed page is untrusted (Phase 2 threat model), so
// we never trust its truncation — every string is re-capped here before it can
// reach the agent prompt, and unknown fields are dropped.
export function sanitizeChatTarget(raw: unknown): ChatTarget | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const t = raw as Record<string, unknown>
  const kind = t.kind === "text" ? "text" : "element"
  const str = (v: unknown, max: number): string | undefined =>
    typeof v === "string" && v.length ? v.slice(0, max) : undefined
  const target: ChatTarget = { kind }
  const selector = str(t.selector, 300)
  const tag = str(t.tag, 40)
  const text = str(t.text, 500)
  const outerHTML = str(t.outerHTML, 800)
  if (selector) target.selector = selector
  if (tag) target.tag = tag
  if (text) target.text = text
  if (outerHTML) target.outerHTML = outerHTML
  if (t.styles && typeof t.styles === "object") {
    const styles: Record<string, string> = {}
    for (const [k, v] of Object.entries(t.styles as Record<string, unknown>)) {
      if (typeof v === "string" && Object.keys(styles).length < 12) styles[k.slice(0, 40)] = v.slice(0, 120)
    }
    if (Object.keys(styles).length) target.styles = styles
  }
  // Nothing usable to anchor on → treat as no target.
  if (!target.selector && !target.text && !target.outerHTML) return undefined
  return target
}

// Strip what a client must never see before returning an app over the API: the
// git token, and the value of every env var marked secret. Clients never need
// either — they can set/clear them via PATCH. `tokenSet` and `secretKeys` are
// surfaced so the CLI can show that something is stored without showing what.
export function scrubApp(app: App): App
export function scrubApp(app: AppInfo): AppInfo
export function scrubApp(app: App | AppInfo): App | AppInfo {
  const scrubbed: App | AppInfo = { ...app }

  if ("env" in scrubbed && scrubbed.secretKeys?.length) {
    scrubbed.env = publicEnv(scrubbed)
  }

  if (scrubbed.git) {
    const { token, ...rest } = scrubbed.git
    scrubbed.git = { ...rest, tokenSet: !!token }
  }

  return scrubbed
}
