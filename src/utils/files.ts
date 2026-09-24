import { readFileSync } from "fs"
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
