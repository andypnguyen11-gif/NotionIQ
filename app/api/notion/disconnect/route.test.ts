import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ getPrisma: () => ({}) }))
const disconnectNotion = vi.fn()
vi.mock('@/lib/data/connections', () => ({ disconnectNotion: (...a: unknown[]) => disconnectNotion(...(a as Parameters<typeof disconnectNotion>)) }))

import { auth } from '@clerk/nextjs/server'
import { POST } from './route'

const mockedAuth = vi.mocked(auth)

describe('POST /api/notion/disconnect', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedAuth.mockResolvedValue({ userId: null } as never)
    const res = await POST()
    expect(res.status).toBe(401)
    expect(disconnectNotion).not.toHaveBeenCalled()
  })

  it('disconnects and returns the result for an authed user', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    disconnectNotion.mockResolvedValue(true)
    const res = await POST()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ disconnected: true })
    expect(disconnectNotion).toHaveBeenCalledWith(expect.anything(), 'user_123')
  })
})
