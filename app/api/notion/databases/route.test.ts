import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }))
vi.mock('@/lib/env', () => ({ getEnv: () => ({ TOKEN_ENCRYPTION_KEY: 'k', NEXT_PUBLIC_APP_URL: 'https://app.test' }) }))
vi.mock('@/lib/prisma', () => ({ getPrisma: () => ({}) }))
const getConnectionForUser = vi.fn()
vi.mock('@/lib/data/connections', () => ({ getConnectionForUser: (p: unknown, u: unknown) => getConnectionForUser(p, u) }))
const decryptToken = vi.fn()
vi.mock('@/lib/crypto/token-cipher', () => ({ decryptToken: (...a: unknown[]) => decryptToken(...a) }))
const searchDatabases = vi.fn()
vi.mock('@/lib/notion/notion-client', () => ({ createNotionClient: () => ({ searchDatabases }) }))
vi.mock('@/lib/notion/rate-limiter', () => ({ createRateLimiter: () => ({ acquire: async () => {} }) }))

import { auth } from '@clerk/nextjs/server'
import { GET } from './route'
const mockedAuth = vi.mocked(auth)

describe('GET /api/notion/databases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    decryptToken.mockReturnValue('tok')
  })

  it('401 when unauthenticated', async () => {
    mockedAuth.mockResolvedValue({ userId: null } as never)
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns an empty list when there is no connection', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    getConnectionForUser.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ databases: [] })
  })

  it('returns databases for a connected workspace', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    getConnectionForUser.mockResolvedValue({ encryptedToken: 'c', notionWorkspaceId: 'nws' })
    searchDatabases.mockResolvedValue({ databases: [{ id: 'db1', title: 'Sales', icon: null, lastEditedTime: '' }], nextCursor: null })
    const res = await GET()
    expect(await res.json()).toEqual({ databases: [{ id: 'db1', title: 'Sales', icon: null, lastEditedTime: '' }] })
  })
})
