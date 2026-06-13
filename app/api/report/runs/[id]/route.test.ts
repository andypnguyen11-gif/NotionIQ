// app/api/report/runs/[id]/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn(async () => ({ userId: 'user_1' })) }))
vi.mock('@/lib/prisma', () => ({ getPrisma: vi.fn(() => ({})) }))
vi.mock('@/lib/data/connections', () => ({ getWorkspaceForUser: vi.fn(async () => ({ id: 'ws_1' })) }))
vi.mock('@/lib/data/reports', () => ({ getReportRunForWorkspace: vi.fn() }))

import { GET } from './route'
import { getReportRunForWorkspace } from '@/lib/data/reports'

const params = (id: string) => ({ params: Promise.resolve({ id }) })

describe('GET /api/report/runs/[id]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns run status for the caller workspace', async () => {
    vi.mocked(getReportRunForWorkspace).mockResolvedValueOnce({ id: 'run_1', status: 'committed', snapshotVersion: 3, results: { factsConsidered: 5, claimsProposed: 4, claimsVerified: 3, claimsDropped: [], empty: false } } as never)
    const res = await GET({} as never, params('run_1'))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('committed')
  })

  it('returns 404 for a run outside the caller workspace', async () => {
    vi.mocked(getReportRunForWorkspace).mockResolvedValueOnce(null)
    const res = await GET({} as never, params('run_other'))
    expect(res.status).toBe(404)
  })
})
