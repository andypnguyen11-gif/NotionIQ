import type { PrismaClient, Prisma } from '@prisma/client'
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'
import type { DbResult } from './scan-runs'

export async function upsertProposedMapping(
  prisma: PrismaClient,
  input: {
    workspaceId: string
    notionDatabaseId: string
    databaseName: string
    schema: unknown
    schemaHash: string
    proposal: DatabaseMappingProposal
    scanRunId: string
  },
): Promise<void> {
  const existing = await prisma.databaseMapping.findUnique({
    where: { workspaceId_notionDatabaseId: { workspaceId: input.workspaceId, notionDatabaseId: input.notionDatabaseId } },
  })
  if (!existing) {
    await prisma.databaseMapping.create({
      data: {
        workspaceId: input.workspaceId,
        notionDatabaseId: input.notionDatabaseId,
        databaseName: input.databaseName,
        classification: input.proposal.classification,
        schema: input.schema as Prisma.InputJsonValue,
        schemaHash: input.schemaHash,
        proposedMapping: input.proposal as Prisma.InputJsonValue,
        status: 'proposed',
        lastScanRunId: input.scanRunId,
      },
    })
    return
  }
  // Re-scan: refresh the proposal; reset approval ONLY if the full-schema hash changed.
  const schemaChanged = existing.schemaHash !== input.schemaHash
  await prisma.databaseMapping.update({
    where: { id: existing.id },
    data: {
      databaseName: input.databaseName,
      classification: input.proposal.classification,
      schema: input.schema as Prisma.InputJsonValue,
      schemaHash: input.schemaHash,
      proposedMapping: input.proposal as Prisma.InputJsonValue,
      lastScanRunId: input.scanRunId,
      ...(schemaChanged ? { status: 'proposed' } : {}),
    },
  })
}

export async function approveMapping(
  prisma: PrismaClient,
  args: { workspaceId: string; mappingId: string; approved: DatabaseMappingProposal },
): Promise<{ notionDatabaseId: string; lastScanRunId: string } | null> {
  const mapping = await prisma.databaseMapping.findFirst({ where: { id: args.mappingId, workspaceId: args.workspaceId } })
  if (!mapping) return null
  await prisma.databaseMapping.update({
    where: { id: mapping.id },
    data: { approvedMapping: args.approved as Prisma.InputJsonValue, status: 'approved' },
  })
  return { notionDatabaseId: mapping.notionDatabaseId, lastScanRunId: mapping.lastScanRunId }
}

export async function listApprovedStatuses(
  prisma: PrismaClient,
  args: { workspaceId: string; notionDatabaseIds: string[] },
): Promise<Set<string>> {
  const rows = await prisma.databaseMapping.findMany({
    where: { workspaceId: args.workspaceId, notionDatabaseId: { in: args.notionDatabaseIds }, status: 'approved' },
    select: { notionDatabaseId: true },
  })
  return new Set(rows.map((r) => r.notionDatabaseId))
}

// Pure: a run is approved when every selected db that did NOT fail has an approved mapping.
export function isRunFullyApproved(results: DbResult[], approvedDbIds: Set<string>): boolean {
  const needed = results.filter((r) => r.status !== 'failed').map((r) => r.notionDatabaseId)
  if (needed.length === 0) return false
  return needed.every((id) => approvedDbIds.has(id))
}
