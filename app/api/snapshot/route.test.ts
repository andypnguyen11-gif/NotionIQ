import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn(async () => ({ userId: 'user_1' })) }))
vi.mock('@/lib/prisma', () => ({ getPrisma: vi.fn(() => ({})) }))
vi.mock('@/lib/env', () => ({ getEnv: vi.fn(() => ({ NEXT_PUBLIC_APP_URL: 'https://app.test' })) }))
vi.mock('@/lib/data/connections', () => ({ getWorkspaceForUser: vi.fn(async () => ({ id: 'ws_1' })) }))
vi.mock('@/lib/data/mappings', () => ({ listApprovedMappings: vi.fn(async () => [{ notionDatabaseId: 'db1' }]) }))
vi.mock('@/lib/data/snapshot-runs', () => ({ createSnapshotRun: vi.fn(async () => ({ id: 'run_1', created: true })) }))
vi.mock('@/lib/jobs/snapshot-queue', () => ({ enqueueSnapshot: vi.fn(async () => {}) }))

import { POST } from './route'
import { listApprovedMappings } from '@/lib/data/mappings'
import { createSnapshotRun } from '@/lib/data/snapshot-runs'
import { enqueueSnapshot } from '@/lib/jobs/snapshot-queue'

function req() {
  return new Request('https://app.test/api/snapshot', { method: 'POST', headers: { origin: 'https://app.test' } }) as never
}

describe('POST /api/snapshot', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a run and enqueues when approved mappings exist', async () => {
    const res = await POST(req())
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ snapshotRunId: 'run_1' })
    expect(enqueueSnapshot).toHaveBeenCalledWith('run_1')
  })

  it('refuses with 400 when there are no approved mappings', async () => {
    vi.mocked(listApprovedMappings).mockResolvedValueOnce([])
    const res = await POST(req())
    expect(res.status).toBe(400)
    expect(enqueueSnapshot).not.toHaveBeenCalled()
  })

  it('single-flight: does not enqueue a second job when a run is already in flight', async () => {
    vi.mocked(createSnapshotRun).mockResolvedValueOnce({ id: 'run_active', created: false })
    const res = await POST(req())
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ snapshotRunId: 'run_active' })
    expect(enqueueSnapshot).not.toHaveBeenCalled()
  })
})
