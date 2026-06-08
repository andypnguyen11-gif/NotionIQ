import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }))
vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    NEXT_PUBLIC_APP_URL: 'https://app.test',
    NOTION_OAUTH_CLIENT_ID: 'cid',
    NOTION_OAUTH_CLIENT_SECRET: 'csecret',
    NOTION_OAUTH_REDIRECT_URI: 'https://app.test/api/notion/callback',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    OAUTH_STATE_SECRET: 'a-sufficiently-long-state-secret',
  }),
}))
vi.mock('@/lib/prisma', () => ({ getPrisma: () => ({}) }))
const saveNotionConnection = vi.fn(async () => ({ workspaceId: 'ws_1' }))
vi.mock('@/lib/data/connections', () => ({ saveNotionConnection: (...a: unknown[]) => saveNotionConnection(...(a as Parameters<typeof saveNotionConnection>)) }))
const exchangeCodeForToken = vi.fn()
vi.mock('@/lib/notion/oauth', () => ({ exchangeCodeForToken: (...a: unknown[]) => exchangeCodeForToken(...(a as Parameters<typeof exchangeCodeForToken>)) }))

import { auth } from '@clerk/nextjs/server'
import { signState, OAUTH_NONCE_COOKIE } from '@/lib/notion/oauth-state'
import { log } from '@/lib/log'
import { GET } from './route'

const mockedAuth = vi.mocked(auth)
const SECRET = 'a-sufficiently-long-state-secret'

function reqWith(params: Record<string, string>, nonceCookie?: string): NextRequest {
  const url = new URL('https://app.test/api/notion/callback')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const headers = nonceCookie ? { cookie: `${OAUTH_NONCE_COOKIE}=${nonceCookie}` } : undefined
  return new NextRequest(url, headers ? { headers } : undefined)
}

describe('GET /api/notion/callback', () => {
  beforeEach(() => vi.clearAllMocks())

  it('redirects to /app?notion=denied when Notion returns an error (user declined)', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    const res = await GET(reqWith({ error: 'access_denied' }))
    expect(res.headers.get('location')).toBe('https://app.test/app?notion=denied')
    expect(exchangeCodeForToken).not.toHaveBeenCalled()
  })

  it('redirects to /app?notion=error when the token exchange throws', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    exchangeCodeForToken.mockRejectedValue(new Error('notion 500'))
    const state = signState({ u: 'user_123', n: 'nonce-A', e: Date.now() + 60_000 }, SECRET)
    const res = await GET(reqWith({ code: 'abc', state }, 'nonce-A'))
    expect(res.headers.get('location')).toBe('https://app.test/app?notion=error')
    expect(saveNotionConnection).not.toHaveBeenCalled()
  })

  it('logs a secret-free exchange-failed event when the token exchange throws', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    exchangeCodeForToken.mockRejectedValue(new Error('notion 500'))
    const errSpy = vi.spyOn(log, 'error')
    const state = signState({ u: 'user_123', n: 'nonce-A', e: Date.now() + 60_000 }, SECRET)
    await GET(reqWith({ code: 'abc', state }, 'nonce-A'))
    expect(errSpy).toHaveBeenCalledWith(
      'notion_oauth_exchange_failed',
      expect.objectContaining({ userId: 'user_123' }),
    )
    const fields = errSpy.mock.calls[0][1] as Record<string, unknown>
    expect(JSON.stringify(fields)).not.toContain('secret') // no client secret / token leaked
  })

  it('redirects to /app?notion=invalid when code or state is missing', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    const res = await GET(reqWith({ code: 'abc' })) // no state
    expect(res.headers.get('location')).toBe('https://app.test/app?notion=invalid')
    expect(exchangeCodeForToken).not.toHaveBeenCalled()
  })

  it('rejects a state belonging to a different user', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    const state = signState({ u: 'someone_else', n: 'n', e: Date.now() + 60_000 }, SECRET)
    const res = await GET(reqWith({ code: 'abc', state }, 'n'))
    expect(res.headers.get('location')).toBe('https://app.test/app?notion=invalid')
    expect(exchangeCodeForToken).not.toHaveBeenCalled()
  })

  it('rejects when the nonce cookie is missing or does not match the state (replay defense)', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    const state = signState({ u: 'user_123', n: 'nonce-A', e: Date.now() + 60_000 }, SECRET)
    const res = await GET(reqWith({ code: 'abc', state }, 'nonce-B')) // cookie mismatch
    expect(res.headers.get('location')).toBe('https://app.test/app?notion=invalid')
    expect(exchangeCodeForToken).not.toHaveBeenCalled()
  })

  it('clears the nonce cookie even when redirecting an unauthenticated user to sign-in', async () => {
    mockedAuth.mockResolvedValue({ userId: null } as never)
    const state = signState({ u: 'user_123', n: 'nonce-A', e: Date.now() + 60_000 }, SECRET)
    const res = await GET(reqWith({ code: 'abc', state }, 'nonce-A'))
    expect(res.headers.get('location')).toBe('https://app.test/sign-in')
    expect(res.cookies.get(OAUTH_NONCE_COOKIE)?.value).toBe('') // consumed on every exit
  })

  it('exchanges, persists encrypted token, clears the cookie, and redirects on a valid callback', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    exchangeCodeForToken.mockResolvedValue({
      accessToken: 'tok',
      botId: 'bot',
      workspaceId: 'ws_notion',
      workspaceName: 'Acme',
    })
    const state = signState({ u: 'user_123', n: 'nonce-A', e: Date.now() + 60_000 }, SECRET)
    const res = await GET(reqWith({ code: 'abc', state }, 'nonce-A'))

    expect(res.headers.get('location')).toBe('https://app.test/app?notion=connected')
    expect(saveNotionConnection).toHaveBeenCalledOnce()
    const [, savedInput] = (saveNotionConnection.mock.calls[0] as unknown) as [unknown, { encryptedToken: string; userId: string }]
    expect(savedInput.userId).toBe('user_123')
    expect(savedInput.encryptedToken).not.toContain('tok') // stored encrypted, never plaintext
    // cookie cleared (maxAge 0) with the same attributes it was set with
    const cleared = res.cookies.get(OAUTH_NONCE_COOKIE)
    expect(cleared?.value).toBe('')
    expect(cleared?.secure).toBe(true) // https deployment → Secure on the clear too
    expect(cleared?.httpOnly).toBe(true)
  })
})
