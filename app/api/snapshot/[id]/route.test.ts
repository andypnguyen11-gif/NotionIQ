import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn(async () => ({ userId: 'user_1' })) }))
vi.mock('@/lib/prisma', () => ({ getPrisma: vi.fn(() => ({})) }))
vi.mock('@/lib/data/connections', () => ({ getWorkspaceForUser: vi.fn(async () => ({ id: 'ws_1' })) }))
vi.mock('@/lib/data/snapshot-runs', () => ({ getSnapshotRunForWorkspace: vi.fn() }))

import { GET } from './route'
import { getSnapshotRunForWorkspace } from '@/lib/data/snapshot-runs'

const params = (id: string) => ({ params: Promise.resolve({ id }) })

describe('GET /api/snapshot/[id]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the run status and results for the caller workspace', async () => {
    vi.mocked(getSnapshotRunForWorkspace).mockResolvedValueOnce({ id: 'run_1', status: 'committed', snapshotVersion: 3, results: [{ sourceDatabaseId: 'db1', status: 'ingested', rowCount: 2 }] } as never)
    const res = await GET({} as never, params('run_1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ snapshotRunId: 'run_1', status: 'committed', snapshotVersion: 3, results: [{ sourceDatabaseId: 'db1', status: 'ingested', rowCount: 2 }] })
    expect(getSnapshotRunForWorkspace).toHaveBeenCalledWith({}, { workspaceId: 'ws_1', snapshotRunId: 'run_1' })
  })

  it('returns 404 for a run that is not in the caller workspace (no cross-tenant leak)', async () => {
    vi.mocked(getSnapshotRunForWorkspace).mockResolvedValueOnce(null)
    const res = await GET({} as never, params('run_other'))
    expect(res.status).toBe(404)
  })
})
