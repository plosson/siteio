import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"

const PREFIX = "enc:v1:"

/**
 * AES-256-GCM encryption for app secrets at rest.
 *
 * The key is a 32-byte random value in a 0600 file next to the app data,
 * generated on first use — agents that never store a secret never create one,
 * so upgrading needs no migration.
 *
 * Scope: this protects the app JSON on disk, not the running container. The
 * value is decrypted and handed to Docker when the container is created, so
 * `docker inspect` on the host still shows it.
 */
export class SecretCipher {
  private keyPath: string
  private key: Buffer | null = null

  constructor(dataDir: string) {
    this.keyPath = join(dataDir, "secrets.key")
  }

  private getKey(): Buffer {
    if (this.key) return this.key

    if (existsSync(this.keyPath)) {
      const key = Buffer.from(readFileSync(this.keyPath, "utf-8").trim(), "base64")
      if (key.length !== 32) {
        throw new Error(`Invalid secret key at ${this.keyPath}: expected 32 bytes`)
      }
      this.key = key
    } else {
      const key = randomBytes(32)
      mkdirSync(dirname(this.keyPath), { recursive: true })
      writeFileSync(this.keyPath, key.toString("base64"), { mode: 0o600 })
      this.key = key
    }

    return this.key
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.getKey(), iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()])
    return PREFIX + [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString("base64")).join(":")
  }

  decrypt(blob: string): string {
    if (!blob.startsWith(PREFIX)) {
      throw new Error("Malformed secret: unknown encoding")
    }
    const parts = blob.slice(PREFIX.length).split(":")
    if (parts.length !== 3) {
      throw new Error("Malformed secret: expected iv:tag:ciphertext")
    }
    const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p!, "base64"))
    const decipher = createDecipheriv("aes-256-gcm", this.getKey(), iv!)
    decipher.setAuthTag(tag!)
    return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString("utf-8")
  }
}
