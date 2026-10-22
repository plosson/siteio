import { Unzip, UnzipInflate, unzipSync } from "fflate"
import { ValidationError } from "../../utils/errors.ts"

// Bounds on what one uploaded zip may expand to. The upload limit only caps the
// compressed bytes; a high-ratio archive (a "zip bomb") or one whose headers
// lie about sizes can otherwise exhaust memory or pin the event loop.
export interface ZipLimits {
  maxUnzippedSize: number // total bytes all entries may expand to
  maxEntries: number // entries in the archive, directories included
  timeoutMs: number // wall-clock budget for inflating one archive
}

export const UNZIPPED_SIZE_RATIO = 10
export const DEFAULT_MAX_ZIP_ENTRIES = 10_000
export const DEFAULT_UNZIP_TIMEOUT_MS = 30_000

// Inflate in small slices so a single push can never produce more than a few
// MB (deflate tops out near 1032:1) and the deadline is checked often.
const PUSH_CHUNK = 16 * 1024

export function zipLimitsFor(config: { maxUploadSize: number; maxUnzippedSize?: number; maxZipEntries?: number }): ZipLimits {
  return {
    maxUnzippedSize: config.maxUnzippedSize ?? config.maxUploadSize * UNZIPPED_SIZE_RATIO,
    maxEntries: config.maxZipEntries ?? DEFAULT_MAX_ZIP_ENTRIES,
    timeoutMs: DEFAULT_UNZIP_TIMEOUT_MS,
  }
}

// An archive that is valid but exceeds a ZipLimits bound. Callers answer 413.
export class ZipLimitError extends ValidationError {
  constructor(message: string) {
    super(message)
    this.name = "ZipLimitError"
  }
}

// An archive that can't be parsed or inflated. Callers answer 400.
export class InvalidZipError extends ValidationError {
  constructor(detail: string) {
    super(`Invalid zip archive: ${detail}`)
    this.name = "InvalidZipError"
  }
}

const mb = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10}MB`

/**
 * Cheap pre-check from the central directory alone: nothing is inflated. Throws
 * ZipLimitError when the entry count or the declared uncompressed total is over
 * the limits, ValidationError when the archive can't be parsed.
 */
export function checkZipDeclared(data: Uint8Array, limits: ZipLimits): void {
  let entries = 0
  let declared = 0
  try {
    unzipSync(data, {
      filter: (file) => {
        if (++entries > limits.maxEntries) {
          throw new ZipLimitError(`Archive has more than ${limits.maxEntries} entries`)
        }
        declared += file.originalSize
        if (declared > limits.maxUnzippedSize) {
          throw new ZipLimitError(`Archive expands to more than ${mb(limits.maxUnzippedSize)}`)
        }
        return false
      },
    })
  } catch (err) {
    if (err instanceof ZipLimitError) throw err
    throw new InvalidZipError(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Unzip `data` within `limits`. Declared sizes are checked first (checkZipDeclared);
 * then entries are stream-inflated in small slices while the bytes actually
 * produced are counted, since a header's size can lie. Directory entries are
 * returned as empty buffers with a trailing "/" (as fflate's unzipSync does).
 */
export function safeUnzip(data: Uint8Array, limits: ZipLimits, now: () => number = () => performance.now()): Record<string, Uint8Array> {
  checkZipDeclared(data, limits)

  const deadline = now() + limits.timeoutMs
  const files: Record<string, Uint8Array> = {}
  let produced = 0
  let seen = 0
  let failure: Error | null = null
  const fail = (err: Error) => {
    if (!failure) failure = err
  }

  const unzip = new Unzip((file) => {
    if (failure) return
    if (++seen > limits.maxEntries) return fail(new ZipLimitError(`Archive has more than ${limits.maxEntries} entries`))
    const chunks: Uint8Array[] = []
    let size = 0
    file.ondata = (err, chunk, final) => {
      if (failure) return
      if (err) return fail(new InvalidZipError(err.message))
      if (chunk && chunk.length) {
        size += chunk.length
        produced += chunk.length
        if (produced > limits.maxUnzippedSize) {
          file.terminate()
          return fail(new ZipLimitError(`Archive expands to more than ${mb(limits.maxUnzippedSize)}`))
        }
        chunks.push(chunk)
      }
      if (final) {
        const out = new Uint8Array(size)
        let offset = 0
        for (const c of chunks) {
          out.set(c, offset)
          offset += c.length
        }
        files[file.name] = out
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)

  try {
    for (let i = 0; i < data.length && !failure; i += PUSH_CHUNK) {
      if (now() > deadline) fail(new ZipLimitError(`Archive took longer than ${limits.timeoutMs / 1000}s to extract`))
      else unzip.push(data.subarray(i, i + PUSH_CHUNK), i + PUSH_CHUNK >= data.length)
    }
  } catch (err) {
    fail(new InvalidZipError(err instanceof Error ? err.message : String(err)))
  }
  if (failure) throw failure
  return files
}
