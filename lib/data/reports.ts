// lib/data/reports.ts
import type { PrismaClient, Prisma } from '@prisma/client'
import { ReportRunResultsSchema, type ReportRunStatus, type ReportRunResults, type VerifiedClaim } from '@/lib/contracts/report'

const ACTIVE_STATUSES = ['queued', 'running', 'rewriting'] as const

// Single-flight: at most one in-flight report run per workspace (partial unique index, migration
// 0005). `rewriting` is active so a write-only retry and a fresh run can't both write the page.
export async function createReportRun(prisma: PrismaClient, input: { workspaceId: string }): Promise<{ id: string; created: boolean }> {
  const inFlight = await prisma.reportRun.findFirst({ where: { workspaceId: input.workspaceId, status: { in: [...ACTIVE_STATUSES] } }, select: { id: true } })
  if (inFlight) return { id: inFlight.id, created: false }
  try {
    const run = await prisma.reportRun.create({ data: { workspaceId: input.workspaceId, status: 'queued' }, select: { id: true } })
    return { id: run.id, created: true }
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      const winner = await prisma.reportRun.findFirst({ where: { workspaceId: input.workspaceId, status: { in: [...ACTIVE_STATUSES] } }, select: { id: true } })
      if (winner) return { id: winner.id, created: false }
    }
    throw err
  }
}

// Claim a write_failed run for a write-only retry. Guarded: only one caller flips it to
// `rewriting`; the partial unique index rejects the flip (P2002) if another active run exists.
export async function claimReportRunForRewrite(prisma: PrismaClient, args: { workspaceId: string; reportRunId: string }): Promise<boolean> {
  try {
    const res = await prisma.reportRun.updateMany({
      where: { id: args.reportRunId, workspaceId: args.workspaceId, status: 'write_failed' },
      data: { status: 'rewriting' },
    })
    return res.count === 1
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return false
    throw err
  }
}

export async function getReportRunForWorkspace(prisma: PrismaClient, args: { workspaceId: string; reportRunId: string }) {
  return prisma.reportRun.findFirst({ where: { id: args.reportRunId, workspaceId: args.workspaceId } })
}

// Tenant-scoped status write (updateMany with workspaceId in the WHERE — structural ADR-3 scope,
// fixing the M3 setSnapshotRunStatus follow-up for the report layer).
export async function setReportRunStatus(
  prisma: PrismaClient,
  args: {
    workspaceId: string
    reportRunId: string
    status: ReportRunStatus
    snapshotVersion?: number
    model?: string
    promptVersion?: string
    inputTokens?: number
    outputTokens?: number
    results?: ReportRunResults
    error?: string
    markStarted?: boolean
    markFinished?: boolean
  },
): Promise<void> {
  const results = args.results ? ReportRunResultsSchema.parse(args.results) : undefined
  await prisma.reportRun.updateMany({
    where: { id: args.reportRunId, workspaceId: args.workspaceId },
    data: {
      status: args.status,
      snapshotVersion: args.snapshotVersion,
      model: args.model,
      promptVersion: args.promptVersion,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      results: results as Prisma.InputJsonValue | undefined,
      error: args.error,
      ...(args.markStarted ? { startedAt: new Date() } : {}),
      ...(args.markFinished ? { finishedAt: new Date() } : {}),
    },
  })
}

export async function persistReportClaims(prisma: PrismaClient, args: { workspaceId: string; reportRunId: string; claims: VerifiedClaim[] }): Promise<void> {
  if (args.claims.length === 0) return
  await prisma.reportClaim.createMany({
    data: args.claims.map((c) => ({
      reportRunId: args.reportRunId,
      workspaceId: args.workspaceId,
      section: c.section,
      kind: c.assertion.kind,
      severity: c.severity,
      template: c.template,
      renderedText: c.renderedText,
      factId: c.fact?.factId,
      factValue: (c.fact?.groups ?? c.fact?.value) as Prisma.InputJsonValue | undefined,
      factSnapshot: c.fact as Prisma.InputJsonValue | undefined,
      verificationStatus: c.verificationStatus,
      reason: c.reason,
    })),
  })
}

export async function upsertReport(
  prisma: PrismaClient,
  args: { workspaceId: string; notionPageId: string; ownedBlockIds: string[]; lastRunId: string; lastSnapshotVersion: number; lastGeneratedAt: Date },
): Promise<void> {
  await prisma.report.upsert({
    where: { workspaceId: args.workspaceId },
    create: { workspaceId: args.workspaceId, notionPageId: args.notionPageId, ownedBlockIds: args.ownedBlockIds, lastRunId: args.lastRunId, lastSnapshotVersion: args.lastSnapshotVersion, lastGeneratedAt: args.lastGeneratedAt },
    update: { notionPageId: args.notionPageId, ownedBlockIds: args.ownedBlockIds, lastRunId: args.lastRunId, lastSnapshotVersion: args.lastSnapshotVersion, lastGeneratedAt: args.lastGeneratedAt },
  })
}

export async function getReport(prisma: PrismaClient, args: { workspaceId: string }) {
  return prisma.report.findUnique({ where: { workspaceId: args.workspaceId } })
}

// Verified claims for a run, rebuilt into renderable VerifiedClaims (write-only retry path).
export async function getVerifiedClaimsForRun(prisma: PrismaClient, args: { workspaceId: string; reportRunId: string }): Promise<VerifiedClaim[]> {
  const rows = await prisma.reportClaim.findMany({ where: { reportRunId: args.reportRunId, workspaceId: args.workspaceId, verificationStatus: 'verified' } })
  return rows.map((r) => ({
    section: r.section as VerifiedClaim['section'],
    template: r.template,
    severity: (r.severity ?? undefined) as VerifiedClaim['severity'],
    assertion: { kind: r.kind } as VerifiedClaim['assertion'],
    verificationStatus: 'verified',
    renderedText: r.renderedText ?? undefined,
    fact: (r.factSnapshot ?? undefined) as VerifiedClaim['fact'],
  }))
}
