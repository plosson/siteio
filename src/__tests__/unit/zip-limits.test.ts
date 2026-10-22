import { describe, test, expect } from "bun:test"
import { zipSync, unzipSync, strToU8 } from "fflate"
import {
  checkZipDeclared,
  InvalidZipError,
  safeUnzip,
  ZipLimitError,
  zipLimitsFor,
  DEFAULT_MAX_ZIP_ENTRIES,
  type ZipLimits,
} from "../../lib/agent/zip-limits.ts"

const MB = 1024 * 1024
const limits = (over: Partial<ZipLimits> = {}): ZipLimits => ({ maxUnzippedSize: 4 * MB, maxEntries: 100, timeoutMs: 30_000, ...over })

// Rewrite the uncompressed size of every entry, in the local headers and the
// central directory, so the archive lies about how big it expands.
function lieAboutSizes(zip: Uint8Array, size: number): Uint8Array {
  const out = zip.slice()
  const dv = new DataView(out.buffer)
  for (let i = 0; i + 4 <= out.length; i++) {
    const sig = dv.getUint32(i, true)
    if (sig === 0x04034b50) dv.setUint32(i + 22, size, true)
    else if (sig === 0x02014b50) dv.setUint32(i + 24, size, true)
  }
  return out
}

// Written by Python's zipfile to a non-seekable stream: sizes live in data
// descriptors after each entry, not in the local headers.
const DATA_DESCRIPTOR_ZIP =
  "UEsDBBQACAAIAPd+Vl0AAAAAAAAAAAAAAAARAAAAcHVibGljL2luZGV4Lmh0bWyzyTC0y0jNyclXSCvKz1VIVCguKUpNzE1NUajKLLDRB8rajKoYVTHgKgBQSwcI+KrkLCoAAACoAgAAUEsDBBQACAAIAPd+Vl0AAAAAAAAAAAAAAAAQAAAAcHVibGljL2VtcHR5LnR4dAMAUEsHCAAAAAACAAAAAAAAAFBLAQIUAxQACAAIAPd+Vl34quQsKgAAAKgCAAARAAAAAAAAAAAAAACAAQAAAABwdWJsaWMvaW5kZXguaHRtbFBLAQIUAxQACAAIAPd+Vl0AAAAAAgAAAAAAAAAQAAAAAAAAAAAAAACAAWkAAABwdWJsaWMvZW1wdHkudHh0UEsFBgAAAAACAAIAfQAAAKkAAAAAAA=="

describe("Unit: zip limits", () => {
  test("defaults: 10x the upload limit and a fixed entry cap, overridable", () => {
    expect(zipLimitsFor({ maxUploadSize: 50 * MB })).toMatchObject({ maxUnzippedSize: 500 * MB, maxEntries: DEFAULT_MAX_ZIP_ENTRIES })
    expect(zipLimitsFor({ maxUploadSize: 50 * MB, maxUnzippedSize: 7, maxZipEntries: 3 })).toMatchObject({ maxUnzippedSize: 7, maxEntries: 3 })
  })

  test("a normal zip extracts exactly as unzipSync does (dirs, empty and stored files)", () => {
    const zip = zipSync({
      "public/": new Uint8Array(0),
      "public/index.html": strToU8("<h1>hi</h1>".repeat(500)),
      "public/empty.txt": new Uint8Array(0),
      "public/raw.bin": [new Uint8Array([1, 2, 3, 4]), { level: 0 }],
      "pb_hooks/main.pb.js": strToU8("// hook"),
    })
    expect(safeUnzip(zip, limits())).toEqual(unzipSync(zip))
  })

  test("a zip with data descriptors extracts", () => {
    const zip = Uint8Array.from(Buffer.from(DATA_DESCRIPTOR_ZIP, "base64"))
    const files = safeUnzip(zip, limits())
    expect(new TextDecoder().decode(files["public/index.html"])).toBe("<h1>hello from a streamed zip</h1>".repeat(20))
    expect(files["public/empty.txt"]!.length).toBe(0)
  })

  test("a high-ratio zip over the budget is refused from its declared sizes", () => {
    const zip = zipSync({ "public/zeros.bin": new Uint8Array(8 * MB) }, { level: 9 })
    expect(zip.length).toBeLessThan(64 * 1024) // tiny upload, 8MB expanded
    expect(() => checkZipDeclared(zip, limits())).toThrow(ZipLimitError)
    expect(() => safeUnzip(zip, limits())).toThrow(/expands to more than 4MB/)
  })

  test("a zip that lies about its sizes is stopped by the bytes actually produced", () => {
    const zip = lieAboutSizes(zipSync({ "public/zeros.bin": new Uint8Array(64 * MB) }, { level: 9 }), 10)
    expect(() => checkZipDeclared(zip, limits())).not.toThrow() // the headers say 10 bytes
    const started = performance.now()
    expect(() => safeUnzip(zip, limits())).toThrow(ZipLimitError)
    // Stops near the 4MB budget instead of inflating all 64MB.
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  test("too many entries is refused", () => {
    const files: Record<string, Uint8Array> = {}
    for (let i = 0; i < 101; i++) files[`public/f${i}.txt`] = strToU8("x")
    const zip = zipSync(files)
    expect(() => safeUnzip(zip, limits())).toThrow(/more than 100 entries/)
    expect(() => safeUnzip(zip, limits({ maxEntries: 101 }))).not.toThrow()
  })

  test("the extraction deadline is enforced", () => {
    const zip = zipSync({ "public/a.bin": new Uint8Array(1 * MB).fill(7) }, { level: 0 })
    let t = 0
    const clock = () => (t += 1_000) // every check advances one second
    expect(() => safeUnzip(zip, limits({ timeoutMs: 5_000 }), clock)).toThrow(/took longer than 5s/)
  })

  test("garbage is an InvalidZipError, not a crash", () => {
    expect(() => safeUnzip(strToU8("definitely not a zip"), limits())).toThrow(InvalidZipError)
    const zip = zipSync({ "public/index.html": strToU8("<h1>hi</h1>".repeat(1000)) })
    expect(() => safeUnzip(zip.slice(0, zip.length - 30), limits())).toThrow(InvalidZipError)
  })
})
