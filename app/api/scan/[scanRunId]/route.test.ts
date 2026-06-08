import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ getPrisma: () => ({}) }))
const getWorkspaceForUser = vi.fn()
vi.mock('@/lib/data/connections', () => ({ getWorkspaceForUser: (...a: unknown[]) => getWorkspaceForUser(...a) }))
const getScanRunForWorkspace = vi.fn()
vi.mock('@/lib/data/scan-runs', () => ({ getScanRunForWorkspace: (...a: unknown[]) => getScanRunForWorkspace(...a) }))

import { auth } from '@clerk/nextjs/server'
import { GET } from './route'
const mockedAuth = vi.mocked(auth)
const ctx = (scanRunId: string) => ({ params: Promise.resolve({ scanRunId }) })

describe('GET /api/scan/[scanRunId]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('401 when unauthenticated', async () => {
    mockedAuth.mockResolvedValue({ userId: null } as never)
    expect((await GET(new Request('https://app.test') as never, ctx('run_1'))).status).toBe(401)
  })

  it('404 when the run is not in the caller workspace', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    getWorkspaceForUser.mockResolvedValue({ id: 'ws_1' })
    getScanRunForWorkspace.mockResolvedValue(null)
    expect((await GET(new Request('https://app.test') as never, ctx('run_x'))).status).toBe(404)
  })

  it('returns status + results', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    getWorkspaceForUser.mockResolvedValue({ id: 'ws_1' })
    getScanRunForWorkspace.mockResolvedValue({ id: 'run_1', status: 'proposed', results: [{ notionDatabaseId: 'db1', status: 'mapped' }] })
    const res = await GET(new Request('https://app.test') as never, ctx('run_1'))
    expect(await res.json()).toEqual({ scanRunId: 'run_1', status: 'proposed', results: [{ notionDatabaseId: 'db1', status: 'mapped' }] })
  })
})
