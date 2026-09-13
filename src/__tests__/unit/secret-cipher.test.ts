import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { SecretCipher } from "../../lib/agent/secret-cipher"

describe("Unit: SecretCipher", () => {
  let testDir: string
  let cipher: SecretCipher

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "siteio-cipher-test-"))
    cipher = new SecretCipher(testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test("round-trips a value", () => {
    const blob = cipher.encrypt("hunter2")
    expect(blob).not.toContain("hunter2")
    expect(cipher.decrypt(blob)).toBe("hunter2")
  })

  test("round-trips unicode and multi-line values", () => {
    const value = "-----BEGIN KEY-----\nüñî©ødé\n-----END KEY-----\n"
    expect(cipher.decrypt(cipher.encrypt(value))).toBe(value)
  })

  test("produces a different blob each time for the same value", () => {
    expect(cipher.encrypt("same")).not.toBe(cipher.encrypt("same"))
  })

  test("generates the key file lazily, 0600", () => {
    const keyPath = join(testDir, "secrets.key")
    expect(existsSync(keyPath)).toBe(false)

    cipher.encrypt("x")
    expect(existsSync(keyPath)).toBe(true)
    expect(statSync(keyPath).mode & 0o777).toBe(0o600)
    expect(Buffer.from(readFileSync(keyPath, "utf-8"), "base64").length).toBe(32)
  })

  test("reuses the key file across instances", () => {
    const blob = cipher.encrypt("persisted")
    expect(new SecretCipher(testDir).decrypt(blob)).toBe("persisted")
  })

  test("rejects a blob encrypted under a different key", () => {
    const otherDir = mkdtempSync(join(tmpdir(), "siteio-cipher-other-"))
    try {
      const blob = new SecretCipher(otherDir).encrypt("value")
      expect(() => cipher.decrypt(blob)).toThrow()
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }
  })

  test("rejects a tampered ciphertext", () => {
    const blob = cipher.encrypt("value")
    const parts = blob.split(":")
    const ct = Buffer.from(parts[4]!, "base64")
    ct[0] = ct[0]! ^ 0xff
    parts[4] = ct.toString("base64")
    expect(() => cipher.decrypt(parts.join(":"))).toThrow()
  })

  test("rejects a malformed blob", () => {
    expect(() => cipher.decrypt("not-encrypted")).toThrow("unknown encoding")
    expect(() => cipher.decrypt("enc:v1:only-one-part")).toThrow("iv:tag:ciphertext")
  })
})
