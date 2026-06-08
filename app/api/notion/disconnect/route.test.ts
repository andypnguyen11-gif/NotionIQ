import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }))
vi.mock('@/lib/env', () => ({ getEnv: () => ({ NEXT_PUBLIC_APP_URL: 'https://app.test' }) }))
vi.mock('@/lib/prisma', () => ({ getPrisma: () => ({}) }))
const disconnectNotion = vi.fn()
vi.mock('@/lib/data/connections', () => ({ disconnectNotion: (...a: unknown[]) => disconnectNotion(...(a as Parameters<typeof disconnectNotion>)) }))

import type { NextRequest } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { POST } from './route'

const mockedAuth = vi.mocked(auth)

function reqWithOrigin(origin: string | null): NextRequest {
  const headers = new Headers()
  if (origin !== null) headers.set('origin', origin)
  return new Request('https://app.test/api/notion/disconnect', {
    method: 'POST',
    headers,
  }) as unknown as NextRequest
}

describe('POST /api/notion/disconnect', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a cross-origin request with 403 and does not touch data', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    const res = await POST(reqWithOrigin('https://evil.test'))
    expect(res.status).toBe(403)
    expect(disconnectNotion).not.toHaveBeenCalled()
  })

  it('rejects a request with no Origin header with 403', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    const res = await POST(reqWithOrigin(null))
    expect(res.status).toBe(403)
    expect(disconnectNotion).not.toHaveBeenCalled()
  })

  it('returns 401 when unauthenticated even with a valid origin', async () => {
    mockedAuth.mockResolvedValue({ userId: null } as never)
    const res = await POST(reqWithOrigin('https://app.test'))
    expect(res.status).toBe(401)
    expect(disconnectNotion).not.toHaveBeenCalled()
  })

  it('disconnects for an authed same-origin request', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    disconnectNotion.mockResolvedValue(true)
    const res = await POST(reqWithOrigin('https://app.test'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ disconnected: true })
    expect(disconnectNotion).toHaveBeenCalledWith(expect.anything(), 'user_123')
  })
})
