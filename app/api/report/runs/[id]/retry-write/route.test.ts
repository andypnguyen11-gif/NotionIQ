// app/api/report/runs/[id]/retry-write/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn(async () => ({ userId: 'user_1' })) }))
vi.mock('@/lib/env', () => ({ getEnv: vi.fn(() => ({ NEXT_PUBLIC_APP_URL: 'https://app.test' })) }))
vi.mock('@/lib/prisma', () => ({ getPrisma: vi.fn(() => ({})) }))
vi.mock('@/lib/data/connections', () => ({ getWorkspaceForUser: vi.fn(async () => ({ id: 'ws_1' })) }))
vi.mock('@/lib/data/reports', () => ({ claimReportRunForRewrite: vi.fn() }))
vi.mock('@/lib/jobs/report-queue', () => ({ enqueueReport: vi.fn(async () => undefined) }))

import { POST } from './route'
import { claimReportRunForRewrite } from '@/lib/data/reports'
import { enqueueReport } from '@/lib/jobs/report-queue'

const req = () => ({ headers: new Headers({ origin: 'https://app.test' }) } as unknown as Request)
const params = (id: string) => ({ params: Promise.resolve({ id }) })

describe('POST /api/report/runs/[id]/retry-write', () => {
  beforeEach(() => vi.clearAllMocks())

  it('claims a write_failed run and enqueues a write-only job', async () => {
    vi.mocked(claimReportRunForRewrite).mockResolvedValueOnce(true)
    const res = await POST(req() as never, params('run_1'))
    expect(res.status).toBe(202)
    expect(enqueueReport).toHaveBeenCalledWith('run_1', 'write_only')
  })

  it('returns 409 when the run is not in write_failed', async () => {
    vi.mocked(claimReportRunForRewrite).mockResolvedValueOnce(false)
    const res = await POST(req() as never, params('run_1'))
    expect(res.status).toBe(409)
    expect(enqueueReport).not.toHaveBeenCalled()
  })
})
