import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }))
vi.mock('@/lib/env', () => ({ getEnv: () => ({ NEXT_PUBLIC_APP_URL: 'https://app.test' }) }))
vi.mock('@/lib/prisma', () => ({ getPrisma: () => ({ databaseMapping: { findFirst: findFirst }, workspaceScanRun: { findFirst: runFind, update: runUpdate } }) }))
vi.mock('@/lib/data/connections', () => ({ getWorkspaceForUser: (...a: unknown[]) => getWorkspaceForUser(...a) }))
vi.mock('@/lib/data/mappings', () => ({
  approveMapping: (...a: unknown[]) => approveMapping(...a),
  listApprovedStatuses: (...a: unknown[]) => listApprovedStatuses(...a),
  isRunFullyApproved: (...a: unknown[]) => isRunFullyApproved(...a),
}))

const getWorkspaceForUser = vi.fn()
const approveMapping = vi.fn()
const listApprovedStatuses = vi.fn()
const isRunFullyApproved = vi.fn()
const findFirst = vi.fn()
const runFind = vi.fn()
const runUpdate = vi.fn()

import type { NextRequest } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { POST } from './route'
const mockedAuth = vi.mocked(auth)

const validEdits = { occurredAtPropertyId: null, roles: {} }
function req(body: unknown, origin: string | null = 'https://app.test'): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (origin !== null) headers.set('origin', origin)
  return new Request('https://app.test/api/mappings/m1/approve', { method: 'POST', headers, body: JSON.stringify(body) }) as unknown as NextRequest
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const proposal = { classification: 'x', occurredAtPropertyId: null, fields: [], modelVersion: 'm', promptVersion: 'mapper-v1' }

describe('POST /api/mappings/[id]/approve', () => {
  beforeEach(() => vi.clearAllMocks())

  it('403 cross-origin', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    expect((await POST(req(validEdits, 'https://evil.test'), ctx('m1'))).status).toBe(403)
  })

  it('404 when the mapping is not in the caller workspace', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    getWorkspaceForUser.mockResolvedValue({ id: 'ws_1' })
    findFirst.mockResolvedValue(null)
    expect((await POST(req(validEdits), ctx('m1'))).status).toBe(404)
  })

  it('approves the mapping and marks the run approved when all are done', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    getWorkspaceForUser.mockResolvedValue({ id: 'ws_1' })
    findFirst.mockResolvedValue({ id: 'm1', workspaceId: 'ws_1', proposedMapping: proposal })
    approveMapping.mockResolvedValue({ notionDatabaseId: 'db1', lastScanRunId: 'run_1' })
    runFind.mockResolvedValue({ id: 'run_1', selectedDatabaseIds: ['db1'], results: [{ notionDatabaseId: 'db1', status: 'mapped' }] })
    listApprovedStatuses.mockResolvedValue(new Set(['db1']))
    isRunFullyApproved.mockReturnValue(true)
    const res = await POST(req(validEdits), ctx('m1'))
    expect(res.status).toBe(200)
    expect(runUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'run_1' }, data: { status: 'approved' } }))
  })
})
