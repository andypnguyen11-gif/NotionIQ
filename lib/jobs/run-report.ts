// lib/jobs/run-report.ts
import { buildFactSheet, computeFact, type FactSheetDb } from '@/lib/reports/fact-sheet'
import { verifyClaims, type Recompute } from '@/lib/reports/verifier'
import { assembleReport, renderClaim } from '@/lib/reports/assemble'
import type { InsightContext, InsightResult } from '@/lib/agents/insight'
import type { MetricRecord } from '@/lib/contracts/normalized'
import type { MetricRequestSpec, ReportRunResults, ReportRunStatus, VerifiedClaim } from '@/lib/contracts/report'
import type { ReportMode } from './report-queue'
import { log } from '@/lib/log'

const TITLE = 'AI Business Review'

export interface RunReportDeps {
  clock(): string
  loadRun(reportRunId: string): Promise<{ workspaceId: string; currentVersion: number; runSnapshotVersion: number | null } | null>
  loadFactInputs(workspaceId: string, currentVersion: number): Promise<{ dbs: FactSheetDb[]; context: InsightContext } | null>
  draft(input: { factSheet: ReturnType<typeof buildFactSheet>; context: InsightContext }): Promise<InsightResult>
  repair(input: { factSheet: ReturnType<typeof buildFactSheet>; context: InsightContext; failures: { template: string; reason: string }[] }): Promise<InsightResult>
  persistClaims(args: { workspaceId: string; reportRunId: string; claims: VerifiedClaim[] }): Promise<void>
  setStatus(args: { workspaceId: string; reportRunId: string; status: ReportRunStatus; snapshotVersion?: number; model?: string; promptVersion?: string; inputTokens?: number; outputTokens?: number; results?: ReportRunResults; error?: string; markStarted?: boolean; markFinished?: boolean }): Promise<void>
  loadReportPointer(workspaceId: string): Promise<{ notionPageId: string | null; ownedBlockIds: string[]; parentPageId: string }>
  writeReport(args: { workspaceId: string; report: ReturnType<typeof assembleReport>; existing: { notionPageId: string | null; ownedBlockIds: string[] }; parentPageId: string; title: string }): Promise<{ notionPageId: string; ownedBlockIds: string[] }>
  upsertReport(args: { workspaceId: string; notionPageId: string; ownedBlockIds: string[]; lastRunId: string; lastSnapshotVersion: number; lastGeneratedAt: Date }): Promise<void>
  deleteOldBlocks(args: { workspaceId: string; blockIds: string[] }): Promise<void>
  loadVerifiedClaims(args: { workspaceId: string; reportRunId: string }): Promise<VerifiedClaim[]>
}

function buildRecompute(dbs: FactSheetDb[], version: number, computedAt: string): Recompute {
  const byDb = new Map<string, { current: MetricRecord[]; previous: MetricRecord[] }>()
  for (const d of dbs) byDb.set(d.sourceDatabaseId, { current: d.current, previous: d.previous })
  return (req: MetricRequestSpec) => computeFact(req, byDb.get(req.sourceDatabaseId) ?? { current: [], previous: [] }, version, computedAt)
}

export async function runReport(deps: RunReportDeps, job: { reportRunId: string; mode: ReportMode }): Promise<void> {
  try {
    const run = await deps.loadRun(job.reportRunId)
    if (!run) return
    if (job.mode === 'write_only') return await writeOnly(deps, run, job.reportRunId)

    await deps.setStatus({ workspaceId: run.workspaceId, reportRunId: job.reportRunId, status: 'running', markStarted: true })

    const inputs = await deps.loadFactInputs(run.workspaceId, run.currentVersion)
    if (!inputs || inputs.dbs.length === 0) {
      await deps.setStatus({ workspaceId: run.workspaceId, reportRunId: job.reportRunId, status: 'failed', error: 'no snapshot data', markFinished: true })
      return
    }

    const computedAt = deps.clock()
    const factSheet = buildFactSheet(inputs.dbs, run.currentVersion, computedAt)
    const recompute = buildRecompute(inputs.dbs, run.currentVersion, computedAt)

    const drafted = await deps.draft({ factSheet, context: inputs.context })
    let verified = verifyClaims(drafted.claims, factSheet, recompute)
    let inputTokens = drafted.inputTokens
    let outputTokens = drafted.outputTokens

    // Single repair budget (D-5): one repair round covering all failures.
    const failures = verified.filter((c) => c.verificationStatus !== 'verified')
    let claimsProposed = drafted.claims.length
    if (failures.length > 0) {
      const repaired = await deps.repair({ factSheet, context: inputs.context, failures: failures.map((f) => ({ template: f.template, reason: f.reason ?? f.verificationStatus })) })
      const reVerified = verifyClaims(repaired.claims, factSheet, recompute)
      verified = [...verified.filter((c) => c.verificationStatus === 'verified'), ...reVerified]
      inputTokens += repaired.inputTokens
      outputTokens += repaired.outputTokens
      claimsProposed += repaired.claims.length
    }

    // Render verified claims with engine numbers; keep failed ones (status only) for audit.
    const finalClaims: VerifiedClaim[] = verified.map((c) => (c.verificationStatus === 'verified' ? { ...c, renderedText: renderClaim(c) } : c))
    const assembled = assembleReport(finalClaims)
    const results: ReportRunResults = {
      factsConsidered: factSheet.facts.length,
      claimsProposed,
      claimsVerified: finalClaims.filter((c) => c.verificationStatus === 'verified').length,
      claimsDropped: finalClaims.filter((c) => c.verificationStatus !== 'verified').map((c) => ({ kind: c.assertion.kind, reason: c.reason ?? c.verificationStatus })),
      empty: assembled.empty,
    }

    // PERSIST BEFORE WRITE (D-8): claims + token usage + results durable first.
    await deps.persistClaims({ workspaceId: run.workspaceId, reportRunId: job.reportRunId, claims: finalClaims })
    await deps.setStatus({ workspaceId: run.workspaceId, reportRunId: job.reportRunId, status: 'running', results, model: drafted.model, promptVersion: drafted.promptVersion, inputTokens, outputTokens })

    const pointer = await deps.loadReportPointer(run.workspaceId)
    let written: { notionPageId: string; ownedBlockIds: string[] }
    try {
      written = await deps.writeReport({ workspaceId: run.workspaceId, report: assembled, existing: { notionPageId: pointer.notionPageId, ownedBlockIds: pointer.ownedBlockIds }, parentPageId: pointer.parentPageId, title: TITLE })
    } catch {
      log.error('report_write_failed', { reportRunId: job.reportRunId })
      await deps.setStatus({ workspaceId: run.workspaceId, reportRunId: job.reportRunId, status: 'write_failed', error: 'notion write failed', markFinished: true })
      return
    }

    // Persist the new pointer FIRST so the DB never references deleted blocks, THEN best-effort
    // delete the old region. deleteOldBlocks never throws, but defensively guard the call so a
    // delete problem can't fail an already-committed run.
    await deps.upsertReport({ workspaceId: run.workspaceId, notionPageId: written.notionPageId, ownedBlockIds: written.ownedBlockIds, lastRunId: job.reportRunId, lastSnapshotVersion: run.currentVersion, lastGeneratedAt: new Date(computedAt) })
    try {
      await deps.deleteOldBlocks({ workspaceId: run.workspaceId, blockIds: pointer.ownedBlockIds })
    } catch {
      log.error('report_delete_old_blocks_failed', { reportRunId: job.reportRunId })
    }
    await deps.setStatus({ workspaceId: run.workspaceId, reportRunId: job.reportRunId, status: 'committed', snapshotVersion: run.currentVersion, markFinished: true })
  } catch {
    log.error('report_run_failed', { reportRunId: job.reportRunId })
    const run = await deps.loadRun(job.reportRunId).catch(() => null)
    if (run) await deps.setStatus({ workspaceId: run.workspaceId, reportRunId: job.reportRunId, status: 'failed', error: 'report run failed', markFinished: true })
  }
}

// Write-only retry: rebuild from persisted verified claims, no AI. Run is already `rewriting`.
async function writeOnly(deps: RunReportDeps, run: { workspaceId: string; runSnapshotVersion: number | null }, reportRunId: string): Promise<void> {
  const claims = await deps.loadVerifiedClaims({ workspaceId: run.workspaceId, reportRunId })
  const assembled = assembleReport(claims)
  const pointer = await deps.loadReportPointer(run.workspaceId)
  let written: { notionPageId: string; ownedBlockIds: string[] }
  try {
    written = await deps.writeReport({ workspaceId: run.workspaceId, report: assembled, existing: { notionPageId: pointer.notionPageId, ownedBlockIds: pointer.ownedBlockIds }, parentPageId: pointer.parentPageId, title: TITLE })
  } catch {
    await deps.setStatus({ workspaceId: run.workspaceId, reportRunId, status: 'write_failed', error: 'notion write failed', markFinished: true })
    return
  }
  await deps.upsertReport({ workspaceId: run.workspaceId, notionPageId: written.notionPageId, ownedBlockIds: written.ownedBlockIds, lastRunId: reportRunId, lastSnapshotVersion: run.runSnapshotVersion ?? 0, lastGeneratedAt: new Date(deps.clock()) })
  try {
    await deps.deleteOldBlocks({ workspaceId: run.workspaceId, blockIds: pointer.ownedBlockIds })
  } catch {
    log.error('report_delete_old_blocks_failed', { reportRunId })
  }
  await deps.setStatus({ workspaceId: run.workspaceId, reportRunId, status: 'committed', snapshotVersion: run.runSnapshotVersion ?? undefined, markFinished: true })
}
