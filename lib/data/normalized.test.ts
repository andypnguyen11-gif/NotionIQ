import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { writeSnapshotRecords, commitSnapshot, cleanOrphanCandidates, getCurrentSnapshot, getCurrentSnapshotRecords, getSnapshotRecordsAtVersion } from './normalized'

function fakePrisma(over: Record<string, unknown> = {}) {
  return {
    normalizedRecord: {
      createMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
    },
    workspace: {
      findUniqueOrThrow: vi.fn(async () => ({ snapshotVersion: 2 })),
      update: vi.fn(async () => ({})),
    },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
    ...over,
  } as unknown as PrismaClient
}

describe('normalized data access', () => {
  it('writeSnapshotRecords bulk-inserts mapped rows for one db/version (idempotent)', async () => {
    const prisma = fakePrisma()
    await writeSnapshotRecords(prisma, {
      workspaceId: 'ws_1',
      sourceDatabaseId: 'db1',
      snapshotVersion: 3,
      records: [{ notionPageId: 'pg1', occurredAt: '2026-06-12T00:00:00.000Z', mappedFields: { measures: {}, dimensions: {}, status: {} }, warnings: [] }],
    })
    expect(prisma.normalizedRecord.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true, data: [expect.objectContaining({ workspaceId: 'ws_1', sourceDatabaseId: 'db1', notionPageId: 'pg1', snapshotVersion: 3 })] }),
    )
  })

  it('commitSnapshot bumps version and prunes < version-1 in one transaction', async () => {
    const prisma = fakePrisma()
    await commitSnapshot(prisma, { workspaceId: 'ws_1', version: 3 })
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.workspace.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'ws_1' }, data: { snapshotVersion: 3 } }))
    expect(prisma.normalizedRecord.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: 'ws_1', snapshotVersion: { lt: 2 } } }))
  })

  it('cleanOrphanCandidates deletes rows above the current version', async () => {
    const prisma = fakePrisma()
    await cleanOrphanCandidates(prisma, { workspaceId: 'ws_1', currentVersion: 2 })
    expect(prisma.normalizedRecord.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: 'ws_1', snapshotVersion: { gt: 2 } } })
  })

  it('getCurrentSnapshotRecords reads ONLY the workspace current version (never orphans)', async () => {
    const prisma = fakePrisma()
    await getCurrentSnapshotRecords(prisma, { workspaceId: 'ws_1' })
    expect(prisma.normalizedRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'ws_1', snapshotVersion: 2 } }),
    )
  })

  it('getCurrentSnapshotRecords maps stored rows into MetricRecords', async () => {
    const prisma = fakePrisma({
      workspace: { findUniqueOrThrow: vi.fn(async () => ({ snapshotVersion: 2 })) },
      normalizedRecord: {
        findMany: vi.fn(async () => [{ occurredAt: new Date('2026-06-12T00:00:00.000Z'), mappedFields: { measures: { amt: { name: 'Amount', value: 5 } }, dimensions: {}, status: {} } }]),
      },
    })
    const recs = await getCurrentSnapshotRecords(prisma, { workspaceId: 'ws_1' })
    expect(recs).toEqual([{ occurredAt: '2026-06-12T00:00:00.000Z', mappedFields: { measures: { amt: { name: 'Amount', value: 5 } }, dimensions: {}, status: {} } }])
  })

  it('getCurrentSnapshot returns the workspace version alongside records', async () => {
    const prisma = fakePrisma({
      workspace: { findUniqueOrThrow: vi.fn(async () => ({ snapshotVersion: 7 })) },
      normalizedRecord: {
        findMany: vi.fn(async () => [{ occurredAt: null, mappedFields: { measures: {}, dimensions: {}, status: {} } }]),
      },
    })
    const res = await getCurrentSnapshot(prisma, { workspaceId: 'ws_1' })
    expect(res.snapshotVersion).toBe(7)
    expect(res.records).toHaveLength(1)
    expect(prisma.normalizedRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: 'ws_1', snapshotVersion: 7 }) }),
    )
  })

  it('getCurrentSnapshot scopes to sourceDatabaseId when provided', async () => {
    const prisma = fakePrisma({
      workspace: { findUniqueOrThrow: vi.fn(async () => ({ snapshotVersion: 2 })) },
      normalizedRecord: { findMany: vi.fn(async () => []) },
    })
    await getCurrentSnapshot(prisma, { workspaceId: 'ws_1', sourceDatabaseId: 'db_9' })
    expect(prisma.normalizedRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ sourceDatabaseId: 'db_9' }) }),
    )
  })

  it('reads normalized records at an explicit version, workspace-scoped', async () => {
    const findMany = vi.fn(async () => [
      { occurredAt: null, mappedFields: { measures: {}, dimensions: {}, status: {} } },
    ])
    const prisma = { normalizedRecord: { findMany } } as unknown as PrismaClient
    const recs = await getSnapshotRecordsAtVersion(prisma, { workspaceId: 'ws_1', version: 2, sourceDatabaseId: 'db1' })
    expect(recs).toHaveLength(1)
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'ws_1', snapshotVersion: 2, sourceDatabaseId: 'db1' } }),
    )
  })
})
