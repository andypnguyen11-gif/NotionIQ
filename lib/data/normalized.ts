import type { PrismaClient, Prisma } from '@prisma/client'
import { MappedFieldsSchema, type MetricRecord, type NormalizedRecordInput } from '@/lib/contracts/normalized'

// Bulk-insert one database's normalized rows at a candidate version. skipDuplicates makes a
// re-ingest idempotent against the @@unique(workspace, db, page, version) constraint.
export async function writeSnapshotRecords(
  prisma: PrismaClient,
  args: { workspaceId: string; sourceDatabaseId: string; snapshotVersion: number; records: NormalizedRecordInput[] },
): Promise<void> {
  if (args.records.length === 0) return
  await prisma.normalizedRecord.createMany({
    skipDuplicates: true,
    data: args.records.map((r) => ({
      workspaceId: args.workspaceId,
      sourceDatabaseId: args.sourceDatabaseId,
      notionPageId: r.notionPageId,
      occurredAt: r.occurredAt ? new Date(r.occurredAt) : null,
      snapshotVersion: args.snapshotVersion,
      mappedFields: r.mappedFields as Prisma.InputJsonValue,
    })),
  })
}

// Atomic cutover (D-4/D-5): bump to the new version and prune everything older than the
// previous version, retaining current + previous only.
export async function commitSnapshot(prisma: PrismaClient, args: { workspaceId: string; version: number }): Promise<void> {
  await prisma.$transaction([
    prisma.workspace.update({ where: { id: args.workspaceId }, data: { snapshotVersion: args.version } }),
    prisma.normalizedRecord.deleteMany({ where: { workspaceId: args.workspaceId, snapshotVersion: { lt: args.version - 1 } } }),
  ])
}

// Drop leftover candidate rows from a prior failed attempt (version > current), at ingest start.
export async function cleanOrphanCandidates(prisma: PrismaClient, args: { workspaceId: string; currentVersion: number }): Promise<void> {
  await prisma.normalizedRecord.deleteMany({ where: { workspaceId: args.workspaceId, snapshotVersion: { gt: args.currentVersion } } })
}

// Reads a specific snapshot version (M3 retains current + previous). Used by M4 to build
// previous-snapshot deltas without reading live Notion. ADR-3 scoped.
export async function getSnapshotRecordsAtVersion(
  prisma: PrismaClient,
  args: { workspaceId: string; version: number; sourceDatabaseId?: string },
): Promise<MetricRecord[]> {
  const rows = await prisma.normalizedRecord.findMany({
    where: { workspaceId: args.workspaceId, snapshotVersion: args.version, ...(args.sourceDatabaseId ? { sourceDatabaseId: args.sourceDatabaseId } : {}) },
  })
  return rows.map((r) => ({
    occurredAt: r.occurredAt ? r.occurredAt.toISOString() : null,
    mappedFields: MappedFieldsSchema.parse(r.mappedFields),
  }))
}

// Read the live snapshot AND the version that produced it, in one workspace-scoped path. The
// version is needed by both the cache key and the chart data contract, and reading it alongside
// the records avoids a race if a scan commits mid-request. Resolves the workspace's current
// version and filters to it, so orphaned N+1 candidates from a failed run are never returned.
// Always workspace-scoped (ADR-3).
export async function getCurrentSnapshot(
  prisma: PrismaClient,
  args: { workspaceId: string; sourceDatabaseId?: string },
): Promise<{ snapshotVersion: number; records: MetricRecord[] }> {
  const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: args.workspaceId }, select: { snapshotVersion: true } })
  const rows = await prisma.normalizedRecord.findMany({
    where: { workspaceId: args.workspaceId, snapshotVersion: ws.snapshotVersion, ...(args.sourceDatabaseId ? { sourceDatabaseId: args.sourceDatabaseId } : {}) },
  })
  return {
    snapshotVersion: ws.snapshotVersion,
    records: rows.map((r) => ({
      occurredAt: r.occurredAt ? r.occurredAt.toISOString() : null,
      mappedFields: MappedFieldsSchema.parse(r.mappedFields),
    })),
  }
}

// Back-compat for M4 callers: records only. Delegates to getCurrentSnapshot so behavior stays identical.
export async function getCurrentSnapshotRecords(
  prisma: PrismaClient,
  args: { workspaceId: string; sourceDatabaseId?: string },
): Promise<MetricRecord[]> {
  return (await getCurrentSnapshot(prisma, args)).records
}
