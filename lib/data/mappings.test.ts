import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { upsertProposedMapping, approveMapping, listApprovedStatuses, isRunFullyApproved } from './mappings'

const proposal = { classification: 'x', occurredAtPropertyId: null, fields: [], modelVersion: 'm', promptVersion: 'mapper-v1' }

describe('upsertProposedMapping', () => {
  it('keeps an approved mapping when schemaHash is unchanged', async () => {
    const prisma = {
      databaseMapping: {
        findUnique: vi.fn(async () => ({ id: 'm1', status: 'approved', schemaHash: 'H' })),
        update: vi.fn(async () => ({ id: 'm1' })),
        create: vi.fn(),
      },
    } as unknown as PrismaClient
    await upsertProposedMapping(prisma, {
      workspaceId: 'ws_1', notionDatabaseId: 'db1', databaseName: 'D', schema: [], schemaHash: 'H', proposal, scanRunId: 'run_1',
    })
    const data = (prisma.databaseMapping.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data
    expect(data.status).toBeUndefined() // unchanged hash => do not touch status
    expect(data.proposedMapping).toEqual(proposal)
  })

  it('resets an approved mapping to proposed when schemaHash changed', async () => {
    const prisma = {
      databaseMapping: {
        findUnique: vi.fn(async () => ({ id: 'm1', status: 'approved', schemaHash: 'OLD' })),
        update: vi.fn(async () => ({ id: 'm1' })),
        create: vi.fn(),
      },
    } as unknown as PrismaClient
    await upsertProposedMapping(prisma, {
      workspaceId: 'ws_1', notionDatabaseId: 'db1', databaseName: 'D', schema: [], schemaHash: 'NEW', proposal, scanRunId: 'run_1',
    })
    const data = (prisma.databaseMapping.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data
    expect(data.status).toBe('proposed')
  })

  it('creates a new proposed mapping when none exists', async () => {
    const prisma = {
      databaseMapping: { findUnique: vi.fn(async () => null), update: vi.fn(), create: vi.fn(async () => ({ id: 'm1' })) },
    } as unknown as PrismaClient
    await upsertProposedMapping(prisma, {
      workspaceId: 'ws_1', notionDatabaseId: 'db1', databaseName: 'D', schema: [], schemaHash: 'H', proposal, scanRunId: 'run_1',
    })
    expect(prisma.databaseMapping.create).toHaveBeenCalled()
  })
})

describe('approveMapping', () => {
  it('returns null when the mapping does not belong to the workspace', async () => {
    const prisma = {
      databaseMapping: {
        findFirst: vi.fn(async () => null),
        update: vi.fn(),
      },
    } as unknown as PrismaClient
    const result = await approveMapping(prisma, { workspaceId: 'ws_1', mappingId: 'm_unknown', approved: proposal })
    expect(result).toBeNull()
    expect(prisma.databaseMapping.update).not.toHaveBeenCalled()
  })

  it('sets approvedMapping and status approved then returns ids', async () => {
    const prisma = {
      databaseMapping: {
        findFirst: vi.fn(async () => ({ id: 'm1', notionDatabaseId: 'db1', lastScanRunId: 'run_1' })),
        update: vi.fn(async () => ({ id: 'm1' })),
      },
    } as unknown as PrismaClient
    const result = await approveMapping(prisma, { workspaceId: 'ws_1', mappingId: 'm1', approved: proposal })
    expect(result).toEqual({ notionDatabaseId: 'db1', lastScanRunId: 'run_1' })
    const updateData = (prisma.databaseMapping.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data
    expect(updateData.status).toBe('approved')
    expect(updateData.approvedMapping).toEqual(proposal)
  })
})

describe('listApprovedStatuses', () => {
  it('returns a set of approved notionDatabaseIds', async () => {
    const prisma = {
      databaseMapping: {
        findMany: vi.fn(async () => [{ notionDatabaseId: 'db1' }, { notionDatabaseId: 'db2' }]),
      },
    } as unknown as PrismaClient
    const result = await listApprovedStatuses(prisma, { workspaceId: 'ws_1', notionDatabaseIds: ['db1', 'db2', 'db3'] })
    expect(result).toEqual(new Set(['db1', 'db2']))
  })
})

describe('isRunFullyApproved', () => {
  it('true only when every non-failed selected db is approved', () => {
    const results = [{ notionDatabaseId: 'db1', status: 'mapped' }, { notionDatabaseId: 'db2', status: 'failed' }]
    expect(isRunFullyApproved(results as never, new Set(['db1']))).toBe(true)
    expect(isRunFullyApproved(results as never, new Set([]))).toBe(false)
  })

  it('returns false when there are no non-failed results', () => {
    const results = [{ notionDatabaseId: 'db1', status: 'failed' }]
    expect(isRunFullyApproved(results as never, new Set(['db1']))).toBe(false)
  })
})
