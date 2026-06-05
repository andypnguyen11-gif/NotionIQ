import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const VERSION = 1 // bump when the key or algorithm rotates; decrypt dispatches on this byte
const IV_BYTES = 12 // 96-bit GCM nonce — fresh random per encryption
const TAG_BYTES = 16

function decodeKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64')
  if (key.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes')
  }
  return key
}

/**
 * Encrypts plaintext with AES-256-GCM, binding the ciphertext to `aad`
 * (e.g. the Notion workspace id). Output = base64(version || iv || authTag || ciphertext).
 */
export function encryptToken(plaintext: string, keyB64: string, aad: string): string {
  const key = decodeKey(keyB64)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]).toString('base64')
}

/** Reverses encryptToken; throws if the version, key, AAD, or auth tag does not match. */
export function decryptToken(encoded: string, keyB64: string, aad: string): string {
  const key = decodeKey(keyB64)
  const buf = Buffer.from(encoded, 'base64')
  const version = buf[0]
  if (version !== VERSION) {
    throw new Error(`Unsupported token cipher version: ${version}`)
  }
  const iv = buf.subarray(1, 1 + IV_BYTES)
  const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES)
  const ciphertext = buf.subarray(1 + IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
