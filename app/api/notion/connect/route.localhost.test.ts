import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same route, but a plain-HTTP app URL (local dev). The nonce cookie must NOT be
// marked `secure`, or the browser drops it and the callback can never read it back.
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }))
vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    NOTION_OAUTH_CLIENT_ID: 'cid',
    NOTION_OAUTH_REDIRECT_URI: 'http://localhost:3000/api/notion/callback',
    OAUTH_STATE_SECRET: 'a-sufficiently-long-state-secret',
  }),
}))

import { auth } from '@clerk/nextjs/server'
import { OAUTH_NONCE_COOKIE } from '@/lib/notion/oauth-state'
import { GET } from './route'

const mockedAuth = vi.mocked(auth)

describe('GET /api/notion/connect over http (local dev)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sets a non-secure nonce cookie so it survives a plain-http round trip', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    const res = await GET()

    const cookie = res.cookies.get(OAUTH_NONCE_COOKIE)
    expect(cookie?.secure).toBe(false)
    expect(cookie?.httpOnly).toBe(true) // still HttpOnly regardless of scheme
  })
})
