import { existsSync, readFileSync } from "fs"
import chalk from "chalk"
import { ValidationError } from "./errors.ts"

// CLI env flags shared by `apps set` and `sites set`.

function parseEnvFile(filePath: string): Record<string, string> {
  const content = readFileSync(filePath, "utf-8")
  const env: Record<string, string> = {}
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const idx = trimmed.indexOf("=")
    if (idx === -1) continue
    const key = trimmed.slice(0, idx).trim()
    let value = trimmed.slice(idx + 1).trim()
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) env[key] = value
  }
  return env
}

/** Split `KEY=rest` for a flag, rejecting a missing `=` or an empty key. */
function splitKeyValue(arg: string, flag: string, valueHint: string): [string, string] {
  const idx = arg.indexOf("=")
  if (idx <= 0) {
    throw new ValidationError(`Invalid ${flag} format: ${arg}. Use KEY=${valueHint}`)
  }
  return [arg.slice(0, idx), arg.slice(idx + 1)]
}

/** `-e KEY=value` / `--secret KEY=value`, or a bare path to an env file. */
export function parseEnvVars(envArgs: string[], flag: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const arg of envArgs) {
    if (!arg.includes("=")) {
      // No '=' found — a bare argument is a path to an env file to bulk-load.
      if (!existsSync(arg)) {
        throw new ValidationError(`Invalid ${flag} format: ${arg}. Use KEY=value or the path to an env file`)
      }
      Object.assign(env, parseEnvFile(arg))
      continue
    }
    const [key, value] = splitKeyValue(arg, flag, "value")
    env[key] = value
  }
  return env
}

/** Drop the single trailing newline a file or a heredoc usually ends with. */
function trimTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, "")
}

/**
 * `--secret-file KEY=/path` — the value is the file's contents, so it never
 * appears in shell history or the process list.
 */
export function parseSecretFiles(args: string[]): Record<string, string> {
  const secrets: Record<string, string> = {}
  for (const arg of args) {
    const [key, path] = splitKeyValue(arg, "--secret-file", "/path/to/file")
    if (!existsSync(path)) {
      throw new ValidationError(`Secret file not found: ${path}`)
    }
    secrets[key] = trimTrailingNewline(readFileSync(path, "utf-8"))
  }
  return secrets
}

export interface EnvFlagOptions { env?: string[]; secret?: string[]; secretFile?: string[]; secretStdin?: string }

// -e / --secret / --secret-file / --secret-stdin → the agent's { env, secrets }.
export async function collectEnvUpdate(
  options: EnvFlagOptions
): Promise<{ env?: Record<string, string>; secrets?: Record<string, string> }> {
  const env = options.env?.length ? parseEnvVars(options.env, "--env") : undefined
  const secrets: Record<string, string> = {
    ...parseEnvVars(options.secret ?? [], "--secret"),
    ...parseSecretFiles(options.secretFile ?? []),
  }
  if (options.secretStdin) {
    if (process.stdin.isTTY) {
      console.error(chalk.dim(`Reading ${options.secretStdin} from stdin (end with Ctrl-D)`))
    }
    const value = trimTrailingNewline(await Bun.stdin.text())
    if (!value) {
      throw new ValidationError(`No value read from stdin for secret ${options.secretStdin}`)
    }
    secrets[options.secretStdin] = value
  }
  const clash = Object.keys(secrets).find((key) => env?.[key] !== undefined)
  if (clash) {
    throw new ValidationError(`'${clash}' given as both --env and --secret. Pick one`)
  }
  return { ...(env && { env }), ...(Object.keys(secrets).length > 0 && { secrets }) }
}
