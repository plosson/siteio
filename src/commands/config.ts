import chalk from "chalk"
import { getUsername, setUsername, getProviderToken, setProviderToken } from "../config/loader.ts"
import { handleError, ValidationError } from "../utils/errors.ts"

const VALID_CONFIG_KEYS = ["username", "hetznerToken", "cloudflareToken"] as const
type ConfigKey = (typeof VALID_CONFIG_KEYS)[number]

function validateConfigKey(key: string): asserts key is ConfigKey {
  if (!VALID_CONFIG_KEYS.includes(key as ConfigKey)) {
    throw new ValidationError(`Unknown config key: ${key}. Available keys: ${VALID_CONFIG_KEYS.join(", ")}`)
  }
}

export async function configSetCommand(
  key: string,
  value: string,
  options: { json?: boolean }
): Promise<void> {
  try {
    validateConfigKey(key)
    if (key === "username") setUsername(value)
    else setProviderToken(key, value)
    const displayValue = key === "username" ? value : "********"

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { [key]: displayValue } }, null, 2))
    } else {
      console.error(chalk.green(`Set ${key} to "${displayValue}"`))
    }
  } catch (err) {
    handleError(err)
  }
}

export async function configGetCommand(
  key: string,
  options: { json?: boolean }
): Promise<void> {
  try {
    validateConfigKey(key)
    const rawValue = key === "username" ? getUsername() : getProviderToken(key)
    const value = key === "username" ? rawValue : rawValue ? "********" : undefined

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { [key]: value || null } }, null, 2))
    } else if (value) {
      console.log(value)
    } else {
      console.error(chalk.yellow(`${key} is not set`))
      console.error(chalk.dim(`Set it with: siteio config set ${key} <value>`))
    }
  } catch (err) {
    handleError(err)
  }
}
