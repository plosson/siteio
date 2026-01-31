import chalk from "chalk"
import {
  loadAgentConfig,
  setAgentConfigValue,
  deleteAgentConfigValue,
  getAgentConfigValue,
  maskSensitiveValue,
  isSensitiveKey,
  type PersistedAgentConfig,
} from "../../config/agent.ts"
import { formatSuccess, formatError, formatWarning } from "../../utils/output.ts"

const VALID_KEYS: (keyof PersistedAgentConfig)[] = ["apiKey", "domain", "cloudflareToken"]

function getDataDir(): string {
  return process.env.SITEIO_DATA_DIR || "/data"
}

export async function listConfigCommand(options: { json?: boolean }): Promise<void> {
  const dataDir = getDataDir()
  const config = loadAgentConfig(dataDir)

  if (options.json) {
    // For JSON output, mask sensitive values
    const masked: Record<string, string> = {}
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined) {
        masked[key] = isSensitiveKey(key) ? maskSensitiveValue(value) : value
      }
    }
    console.log(JSON.stringify(masked, null, 2))
    return
  }

  console.log(chalk.cyan.bold("Agent Configuration"))
  console.log(chalk.gray(`Path: ${dataDir}/agent-config.json`))
  console.log("")

  if (Object.keys(config).length === 0) {
    console.log(chalk.gray("  (no configuration set)"))
    return
  }

  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) {
      const displayValue = isSensitiveKey(key) ? maskSensitiveValue(value) : value
      console.log(`  ${chalk.bold(key)}: ${displayValue}`)
    }
  }
}

export async function getConfigCommand(
  key: string,
  options: { json?: boolean }
): Promise<void> {
  if (!VALID_KEYS.includes(key as keyof PersistedAgentConfig)) {
    console.error(formatError(`Unknown config key: ${key}`))
    console.error(chalk.gray(`Valid keys: ${VALID_KEYS.join(", ")}`))
    process.exit(1)
  }

  const dataDir = getDataDir()
  const value = getAgentConfigValue(dataDir, key as keyof PersistedAgentConfig)

  if (options.json) {
    console.log(JSON.stringify({ [key]: value ?? null }))
    return
  }

  if (value === undefined) {
    console.log(chalk.gray("(not set)"))
  } else {
    console.log(value)
  }
}

export async function setConfigCommand(
  key: string,
  value: string,
  options: { json?: boolean }
): Promise<void> {
  if (!VALID_KEYS.includes(key as keyof PersistedAgentConfig)) {
    console.error(formatError(`Unknown config key: ${key}`))
    console.error(chalk.gray(`Valid keys: ${VALID_KEYS.join(", ")}`))
    process.exit(1)
  }

  const dataDir = getDataDir()

  try {
    setAgentConfigValue(dataDir, key as keyof PersistedAgentConfig, value)

    if (options.json) {
      console.log(JSON.stringify({ success: true, key, value: isSensitiveKey(key) ? maskSensitiveValue(value) : value }))
    } else {
      const displayValue = isSensitiveKey(key) ? maskSensitiveValue(value) : value
      console.log(formatSuccess(`Set ${key} = ${displayValue}`))
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(formatError(`Failed to set config: ${message}`))
    process.exit(1)
  }
}

export async function unsetConfigCommand(
  key: string,
  options: { json?: boolean }
): Promise<void> {
  if (!VALID_KEYS.includes(key as keyof PersistedAgentConfig)) {
    console.error(formatError(`Unknown config key: ${key}`))
    console.error(chalk.gray(`Valid keys: ${VALID_KEYS.join(", ")}`))
    process.exit(1)
  }

  // Prevent unsetting required keys
  if (key === "apiKey") {
    console.error(formatError("Cannot unset apiKey - it is required"))
    process.exit(1)
  }

  const dataDir = getDataDir()

  try {
    deleteAgentConfigValue(dataDir, key as keyof PersistedAgentConfig)

    if (options.json) {
      console.log(JSON.stringify({ success: true, key }))
    } else {
      console.log(formatSuccess(`Unset ${key}`))
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(formatError(`Failed to unset config: ${message}`))
    process.exit(1)
  }
}
