import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { ValidationError } from "./errors.ts"

/**
 * Read a local file named by a CLI flag. Returns undefined when the flag was
 * not given; a missing or unreadable file is a ValidationError naming what
 * the file was for (e.g. "compose file").
 */
export function readFlagFile(path: string | undefined, what: string): string | undefined {
  if (!path) return undefined
  try {
    return readFileSync(path, "utf-8")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ValidationError(`Failed to read ${what} at '${path}': ${message}`)
  }
}

// Read every file under `dir` into a map of "/"-separated relative path ->
// bytes. Empty when `dir` does not exist.
export function readTree(dir: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {}
  if (!existsSync(dir)) return out
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      if (statSync(full).isDirectory()) walk(full)
      else out[full.slice(dir.length + 1).replace(/\\/g, "/")] = readFileSync(full)
    }
  }
  walk(dir)
  return out
}
