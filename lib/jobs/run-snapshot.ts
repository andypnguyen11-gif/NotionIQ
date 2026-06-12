import { normalizeRow } from '@/lib/normalize/normalize-row'
import type { TypedRow, NormalizedRecordInput } from '@/lib/contracts/normalized'
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'
import type { SnapshotRunStatus, SnapshotRunResults } from '@/lib/contracts/snapshot-run'
import { log } from '@/lib/log'

export interface RunSnapshotDeps {
  loadRun(snapshotRunId: string): Promise<{ workspaceId: string; currentVersion: number }>
  loadApprovedMappings(workspaceId: string): Promise<{ notionDatabaseId: string; approvedMapping: DatabaseMappingProposal }[]>
  cleanOrphans(workspaceId: string, currentVersion: number): Promise<void>
  read(notionDatabaseId: string): Promise<TypedRow[]>
  write(args: { workspaceId: string; sourceDatabaseId: string; snapshotVersion: number; records: NormalizedRecordInput[] }): Promise<void>
  commit(workspaceId: string, version: number): Promise<void>
  setStatus(snapshotRunId: string, args: { status: SnapshotRunStatus; snapshotVersion?: number; results?: SnapshotRunResults; error?: string; markStarted?: boolean; markFinished?: boolean }): Promise<void>
}

// All-or-nothing ingest (spec D-4). Bumps the live version only if every approved database
// succeeds; otherwise leaves the previous snapshot active and records partial/failed.
export async function runSnapshot(deps: RunSnapshotDeps, snapshotRunId: string): Promise<void> {
  try {
    const run = await deps.loadRun(snapshotRunId)
    await deps.setStatus(snapshotRunId, { status: 'running', markStarted: true })

    const mappings = await deps.loadApprovedMappings(run.workspaceId)
    if (mappings.length === 0) {
      await deps.setStatus(snapshotRunId, { status: 'failed', error: 'no approved mappings', markFinished: true })
      return
    }

    const target = run.currentVersion + 1
    await deps.cleanOrphans(run.workspaceId, run.currentVersion)

    const results: SnapshotRunResults = []
    let allOk = true
    for (const m of mappings) {
      try {
        const rows = await deps.read(m.notionDatabaseId)
        const records = rows.map((r) => normalizeRow(r, m.approvedMapping))
        await deps.write({ workspaceId: run.workspaceId, sourceDatabaseId: m.notionDatabaseId, snapshotVersion: target, records })
        results.push({ sourceDatabaseId: m.notionDatabaseId, status: 'ingested', rowCount: records.length })
      } catch (err) {
        allOk = false
        const code = (err as { code?: string }).code ?? 'INGEST_ERROR'
        log.error('snapshot_db_failed', { snapshotRunId, sourceDatabaseId: m.notionDatabaseId, errorCode: code })
        results.push({ sourceDatabaseId: m.notionDatabaseId, status: 'failed', error: code })
      }
    }

    if (allOk) {
      await deps.commit(run.workspaceId, target)
      await deps.setStatus(snapshotRunId, { status: 'committed', snapshotVersion: target, results, markFinished: true })
    } else {
      const anyOk = results.some((r) => r.status === 'ingested')
      await deps.setStatus(snapshotRunId, { status: anyOk ? 'partial' : 'failed', results, markFinished: true })
    }
  } catch {
    log.error('snapshot_run_failed', { snapshotRunId })
    await deps.setStatus(snapshotRunId, { status: 'failed', error: 'snapshot run failed', markFinished: true })
  }
}
