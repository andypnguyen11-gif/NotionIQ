import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { encryptToken, decryptToken } from './token-cipher'

const keyB64 = randomBytes(32).toString('base64')
const aad = 'notion-workspace-123'

describe('token-cipher', () => {
  it('round-trips a plaintext token with matching AAD', () => {
    const ciphertext = encryptToken('secret-notion-token', keyB64, aad)
    expect(decryptToken(ciphertext, keyB64, aad)).toBe('secret-notion-token')
  })

  it('produces different ciphertext each call (random IV) and is not the plaintext', () => {
    const a = encryptToken('same', keyB64, aad)
    const b = encryptToken('same', keyB64, aad)
    expect(a).not.toBe(b)
    expect(a).not.toContain('same')
  })

  it('writes a recognizable version byte as the first byte of the envelope', () => {
    const ciphertext = encryptToken('secret', keyB64, aad)
    expect(Buffer.from(ciphertext, 'base64')[0]).toBe(1)
  })

  it('rejects decryption with a different AAD (workspace binding)', () => {
    const ciphertext = encryptToken('secret', keyB64, aad)
    expect(() => decryptToken(ciphertext, keyB64, 'different-workspace')).toThrow()
  })

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    const ciphertext = encryptToken('secret', keyB64, aad)
    const buf = Buffer.from(ciphertext, 'base64')
    buf[buf.length - 1] ^= 0x01 // flip a bit in the ciphertext
    expect(() => decryptToken(buf.toString('base64'), keyB64, aad)).toThrow()
  })

  it('rejects decryption with the wrong key', () => {
    const ciphertext = encryptToken('secret', keyB64, aad)
    const otherKey = randomBytes(32).toString('base64')
    expect(() => decryptToken(ciphertext, otherKey, aad)).toThrow()
  })

  it('rejects a key that is not 32 bytes', () => {
    const shortKey = randomBytes(16).toString('base64')
    expect(() => encryptToken('secret', shortKey, aad)).toThrow(/32 bytes/)
  })
})
