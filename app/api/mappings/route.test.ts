import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ getPrisma: () => ({}) }))
const getWorkspaceForUser = vi.fn()
vi.mock('@/lib/data/connections', () => ({ getWorkspaceForUser: (...a: unknown[]) => getWorkspaceForUser(...a) }))
const listMappingsForRun = vi.fn()
vi.mock('@/lib/data/mappings', () => ({ listMappingsForRun: (...a: unknown[]) => listMappingsForRun(...a) }))

import type { NextRequest } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { GET } from './route'
const mockedAuth = vi.mocked(auth)
const req = (url: string) => new Request(url) as unknown as NextRequest

describe('GET /api/mappings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('401 when unauthenticated', async () => {
    mockedAuth.mockResolvedValue({ userId: null } as never)
    expect((await GET(req('https://app.test/api/mappings?scanRunId=run_1'))).status).toBe(401)
  })

  it('400 when scanRunId is missing', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    getWorkspaceForUser.mockResolvedValue({ id: 'ws_1' })
    expect((await GET(req('https://app.test/api/mappings'))).status).toBe(400)
  })

  it('returns mappings for the run', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    getWorkspaceForUser.mockResolvedValue({ id: 'ws_1' })
    listMappingsForRun.mockResolvedValue([{ id: 'm1', notionDatabaseId: 'db1', databaseName: 'Sales', status: 'proposed', proposedMapping: {}, approvedMapping: null }])
    const res = await GET(req('https://app.test/api/mappings?scanRunId=run_1'))
    expect(res.status).toBe(200)
    expect((await res.json()).mappings).toHaveLength(1)
  })
})
