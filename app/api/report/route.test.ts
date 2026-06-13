// app/api/report/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn(async () => ({ userId: 'user_1' })) }))
vi.mock('@/lib/env', () => ({ getEnv: vi.fn(() => ({ NEXT_PUBLIC_APP_URL: 'https://app.test' })) }))
vi.mock('@/lib/prisma', () => ({ getPrisma: vi.fn(() => ({})) }))
vi.mock('@/lib/data/connections', () => ({ getWorkspaceForUser: vi.fn(async () => ({ id: 'ws_1' })) }))
vi.mock('@/lib/data/reports', () => ({ createReportRun: vi.fn() }))
vi.mock('@/lib/jobs/report-queue', () => ({ enqueueReport: vi.fn(async () => undefined) }))

import { POST } from './route'
import { createReportRun } from '@/lib/data/reports'
import { enqueueReport } from '@/lib/jobs/report-queue'

function req() {
  return { headers: new Headers({ origin: 'https://app.test' }) } as unknown as Request
}

describe('POST /api/report', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a run and enqueues a full job', async () => {
    vi.mocked(createReportRun).mockResolvedValueOnce({ id: 'run_1', created: true })
    const res = await POST(req() as never)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ reportRunId: 'run_1' })
    expect(enqueueReport).toHaveBeenCalledWith('run_1', 'full')
  })

  it('single-flight: existing run is returned without enqueue', async () => {
    vi.mocked(createReportRun).mockResolvedValueOnce({ id: 'run_active', created: false })
    const res = await POST(req() as never)
    expect(res.status).toBe(202)
    expect(enqueueReport).not.toHaveBeenCalled()
  })

  it('rejects a cross-origin request', async () => {
    const bad = { headers: new Headers({ origin: 'https://evil.test' }) } as unknown as Request
    const res = await POST(bad as never)
    expect(res.status).toBe(403)
  })
})
