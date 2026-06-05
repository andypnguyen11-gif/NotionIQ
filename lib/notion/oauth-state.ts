import { createHmac, timingSafeEqual } from 'node:crypto'

/** First-party cookie that mirrors the state nonce for one-time replay defense. */
export const OAUTH_NONCE_COOKIE = 'notion_oauth_nonce'

/** u = Clerk userId, n = random nonce, e = absolute expiry in epoch ms. */
export type StatePayload = { u: string; n: string; e: number }

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function sign(body: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(body).digest())
}

/** Returns `base64url(json).base64url(hmac)`. */
export function signState(payload: StatePayload, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)))
  return `${body}.${sign(body, secret)}`
}

/** Verifies signature + expiry; returns the payload or null. */
export function verifyState(token: string, secret: string, nowMs: number): StatePayload | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, sig] = parts

  const expected = sign(body, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  let payload: StatePayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload
  } catch {
    return null
  }
  if (typeof payload.u !== 'string' || typeof payload.n !== 'string') return null
  if (typeof payload.e !== 'number' || payload.e < nowMs) return null
  return payload
}
