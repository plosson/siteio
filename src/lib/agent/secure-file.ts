import { renameSync, writeFileSync } from "fs"

/**
 * Write a file that must never be world-readable — app records, the generated
 * compose override, anything holding secrets.
 *
 * Via a temp file + rename, because `writeFileSync`'s `mode` only applies when
 * open() creates the file: writing 0600 straight onto a path that already
 * exists keeps whatever mode it had (0644, for records written by older
 * agents) while the new contents are already there. The rename installs a
 * fresh 0600 inode instead, and makes the replacement atomic.
 */
export function writeSecureFile(path: string, content: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content, { mode: 0o600 })
  renameSync(tmp, path)
}
