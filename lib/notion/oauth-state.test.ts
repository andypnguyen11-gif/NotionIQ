import { describe, it, expect } from 'vitest'
import { signState, verifyState, OAUTH_NONCE_COOKIE } from './oauth-state'

const secret = 'a-sufficiently-long-state-secret'
const now = 1_000_000

describe('oauth-state', () => {
  it('exposes a stable cookie name', () => {
    expect(OAUTH_NONCE_COOKIE).toBe('notion_oauth_nonce')
  })

  it('round-trips a signed state', () => {
    const token = signState({ u: 'user_123', n: 'nonce', e: now + 1000 }, secret)
    expect(verifyState(token, secret, now)).toEqual({ u: 'user_123', n: 'nonce', e: now + 1000 })
  })

  it('rejects a state signed with a different secret', () => {
    const token = signState({ u: 'user_123', n: 'nonce', e: now + 1000 }, secret)
    expect(verifyState(token, 'another-secret-entirely', now)).toBeNull()
  })

  it('rejects a tampered body', () => {
    const token = signState({ u: 'user_123', n: 'nonce', e: now + 1000 }, secret)
    const sig = token.split('.')[1]
    const forged = Buffer.from('{"u":"attacker","n":"n","e":9999999}').toString('base64url')
    expect(verifyState(`${forged}.${sig}`, secret, now)).toBeNull()
  })

  it('rejects an expired state', () => {
    const token = signState({ u: 'user_123', n: 'nonce', e: now - 1 }, secret)
    expect(verifyState(token, secret, now)).toBeNull()
  })

  it('rejects a malformed token', () => {
    expect(verifyState('not-a-valid-token', secret, now)).toBeNull()
  })
})
