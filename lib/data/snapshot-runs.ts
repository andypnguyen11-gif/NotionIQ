import type { PrismaClient, Prisma } from '@prisma/client'
import { SnapshotRunResultsSchema, type SnapshotRunStatus, type SnapshotRunResults } from '@/lib/contracts/snapshot-run'

// Active statuses hold the workspace's single in-flight slot. A partial unique index
// (migration 0004) enforces at-most-one of these per workspace at the DB level; this
// function short-circuits the common case and recovers gracefully from the race.
const ACTIVE_STATUSES = ['queued', 'running'] as const

// Single-flight: a workspace may have at most one in-flight snapshot run. Two concurrent
// runs would both target snapshotVersion N+1, and one's candidate-row cleanup would delete
// the other's writes — corrupting a "committed" snapshot. `created` lets the caller skip
// re-enqueuing when an existing run is returned.
export async function createSnapshotRun(prisma: PrismaClient, input: { workspaceId: string }): Promise<{ id: string; created: boolean }> {
  const inFlight = await prisma.snapshotRun.findFirst({
    where: { workspaceId: input.workspaceId, status: { in: [...ACTIVE_STATUSES] } },
    select: { id: true },
  })
  if (inFlight) return { id: inFlight.id, created: false }
  try {
    const run = await prisma.snapshotRun.create({ data: { workspaceId: input.workspaceId, status: 'queued' }, select: { id: true } })
    return { id: run.id, created: true }
  } catch (err) {
    // Lost the insert race against a concurrent request — the partial unique index rejected
    // this row. Return whichever run won, so the caller polls a live run instead of erroring.
    if ((err as { code?: string }).code === 'P2002') {
      const winner = await prisma.snapshotRun.findFirst({
        where: { workspaceId: input.workspaceId, status: { in: [...ACTIVE_STATUSES] } },
        select: { id: true },
      })
      if (winner) return { id: winner.id, created: false }
    }
    throw err
  }
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
