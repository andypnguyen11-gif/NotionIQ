import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }))
vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    NEXT_PUBLIC_APP_URL: 'https://app.test',
    NOTION_OAUTH_CLIENT_ID: 'cid',
    NOTION_OAUTH_REDIRECT_URI: 'https://app.test/api/notion/callback',
    OAUTH_STATE_SECRET: 'a-sufficiently-long-state-secret',
  }),
}))

import { auth } from '@clerk/nextjs/server'
import { verifyState, OAUTH_NONCE_COOKIE } from '@/lib/notion/oauth-state'
import { GET } from './route'

const mockedAuth = vi.mocked(auth)

describe('GET /api/notion/connect', () => {
  beforeEach(() => vi.clearAllMocks())

  it('redirects an authed user to Notion and sets a nonce cookie matching the state', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    const res = await GET()

    const location = res.headers.get('location') ?? ''
    expect(location).toContain('https://api.notion.com/v1/oauth/authorize')
    expect(location).toContain('client_id=cid')

    const state = new URL(location).searchParams.get('state') ?? ''
    const payload = verifyState(state, 'a-sufficiently-long-state-secret', Date.now())
    expect(payload?.u).toBe('user_123')

    const cookie = res.cookies.get(OAUTH_NONCE_COOKIE)
    expect(cookie?.value).toBe(payload?.n)
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.secure).toBe(true) // https deployment → Secure cookie
  })

  it('redirects an unauthenticated user to sign-in', async () => {
    mockedAuth.mockResolvedValue({ userId: null } as never)
    const res = await GET()
    expect(res.headers.get('location')).toBe('https://app.test/sign-in')
  })
})
