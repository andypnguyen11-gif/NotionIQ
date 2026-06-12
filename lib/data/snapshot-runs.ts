import type { PrismaClient, Prisma } from '@prisma/client'
import { SnapshotRunResultsSchema, type SnapshotRunStatus, type SnapshotRunResults } from '@/lib/contracts/snapshot-run'

export async function createSnapshotRun(prisma: PrismaClient, input: { workspaceId: string }): Promise<{ id: string }> {
  return prisma.snapshotRun.create({ data: { workspaceId: input.workspaceId, status: 'queued' }, select: { id: true } })
}

export async function getSnapshotRunForWorkspace(prisma: PrismaClient, args: { workspaceId: string; snapshotRunId: string }) {
  return prisma.snapshotRun.findFirst({ where: { id: args.snapshotRunId, workspaceId: args.workspaceId } })
}

// Single update used across the lifecycle. results is validated against the shared contract
// before persisting; markStarted/markFinished stamp timestamps so the pure handler stays
// deterministic (no Date in run-snapshot.ts).
export async function setSnapshotRunStatus(
  prisma: PrismaClient,
  args: {
    snapshotRunId: string
    status: SnapshotRunStatus
    snapshotVersion?: number
    results?: SnapshotRunResults
    error?: string
    markStarted?: boolean
    markFinished?: boolean
  },
): Promise<void> {
  const results = args.results ? SnapshotRunResultsSchema.parse(args.results) : undefined
  await prisma.snapshotRun.update({
    where: { id: args.snapshotRunId },
    data: {
      status: args.status,
      snapshotVersion: args.snapshotVersion,
      results: results as Prisma.InputJsonValue | undefined,
      error: args.error,
      ...(args.markStarted ? { startedAt: new Date() } : {}),
      ...(args.markFinished ? { finishedAt: new Date() } : {}),
    },
  })
}
