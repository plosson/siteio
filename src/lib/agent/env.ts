import { ValidationError } from "../../utils/errors.ts"

// Env vars for apps and sites. Secrets are ordinary env entries whose keys are
// listed in `secretKeys`: stored like any value, but never returned by the API.

export interface EnvState { env: Record<string, string>; secretKeys?: string[] }
export interface EnvUpdate { env?: Record<string, string>; secrets?: Record<string, string>; unsetEnv?: string[] }

// Merge `update` into `current` additively. `secretKeys` is derived here, never
// taken from a client.
export function applyEnvUpdate(current: Partial<EnvState>, update: EnvUpdate, noun: "apps" | "sites"): EnvState {
  const env = { ...(current.env ?? {}), ...(update.env ?? {}), ...(update.secrets ?? {}) }
  const secretKeys = new Set([...(current.secretKeys ?? []), ...Object.keys(update.secrets ?? {})])

  // Refuse to un-secret a key with a plain `-e`. The value can't be read back
  // to check what it was, so that is far more likely a mistake than intent.
  for (const key of Object.keys(update.env ?? {})) {
    if (secretKeys.has(key) && !update.secrets?.[key]) {
      throw new ValidationError(
        `'${key}' is a secret. Set it with --secret ${key}=<value>, or remove it first with '${noun} unset -e ${key}'`
      )
    }
  }

  for (const key of update.unsetEnv ?? []) {
    delete env[key]
    secretKeys.delete(key)
  }

  return secretKeys.size > 0 ? { env, secretKeys: [...secretKeys] } : { env }
}

// The env a client may see: every secret value dropped.
export function publicEnv(state: Partial<EnvState>): Record<string, string> {
  const secret = new Set(state.secretKeys ?? [])
  return Object.fromEntries(Object.entries(state.env ?? {}).filter(([key]) => !secret.has(key)))
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
// The agent's own container vars (POCKET_SUPERUSER_*) live under this prefix.
const RESERVED_PREFIX = "POCKET_"

// Site env keys become `docker run -e KEY=…` and `$os.getenv("KEY")`: plain
// identifiers only, and never the agent's own vars.
export function assertValidSiteEnvKeys(update: EnvUpdate): void {
  const keys = [...Object.keys(update.env ?? {}), ...Object.keys(update.secrets ?? {}), ...(update.unsetEnv ?? [])]
  for (const key of keys) {
    if (!ENV_KEY_RE.test(key)) throw new ValidationError(`Invalid env var name: '${key}'`)
    if (key.startsWith(RESERVED_PREFIX)) throw new ValidationError(`'${key}' is reserved: ${RESERVED_PREFIX}* vars belong to siteio`)
  }
}
