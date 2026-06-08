import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }))
vi.mock('@/lib/env', () => ({ getEnv: () => ({ NEXT_PUBLIC_APP_URL: 'https://app.test' }) }))
vi.mock('@/lib/prisma', () => ({ getPrisma: () => ({}) }))
const getWorkspaceForUser = vi.fn()
vi.mock('@/lib/data/connections', () => ({ getWorkspaceForUser: (...a: unknown[]) => getWorkspaceForUser(...a) }))
const createScanRun = vi.fn()
vi.mock('@/lib/data/scan-runs', () => ({ createScanRun: (...a: unknown[]) => createScanRun(...a) }))
const enqueueScan = vi.fn()
vi.mock('@/lib/jobs/queue', () => ({ enqueueScan: (...a: unknown[]) => enqueueScan(...a) }))

import type { NextRequest } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { POST } from './route'
const mockedAuth = vi.mocked(auth)

function req(body: unknown, origin: string | null = 'https://app.test'): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (origin !== null) headers.set('origin', origin)
  return new Request('https://app.test/api/scan', { method: 'POST', headers, body: JSON.stringify(body) }) as unknown as NextRequest
}

describe('POST /api/scan', () => {
  beforeEach(() => vi.clearAllMocks())

  it('403 cross-origin without enqueuing', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    const res = await POST(req({ databaseIds: ['db1'] }, 'https://evil.test'))
    expect(res.status).toBe(403)
    expect(enqueueScan).not.toHaveBeenCalled()
  })

  it('401 when unauthenticated', async () => {
    mockedAuth.mockResolvedValue({ userId: null } as never)
    expect((await POST(req({ databaseIds: ['db1'] }))).status).toBe(401)
  })

  it('400 on an empty database selection', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    expect((await POST(req({ databaseIds: [] }))).status).toBe(400)
  })

  it('creates a run and enqueues, returning scanRunId', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    getWorkspaceForUser.mockResolvedValue({ id: 'ws_1' })
    createScanRun.mockResolvedValue({ id: 'run_1' })
    const res = await POST(req({ databaseIds: ['db1', 'db2'] }))
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ scanRunId: 'run_1' })
    expect(enqueueScan).toHaveBeenCalledWith('run_1')
  })
})
