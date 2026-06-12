import type { SnapshotRunResults } from '@/lib/contracts/snapshot-run'

export function snapshotCtaLabel(hasCommittedSnapshot: boolean): string {
  return hasCommittedSnapshot ? 'Refresh data snapshot' : 'Build data snapshot'
}

export function canBuildSnapshot(args: { allApproved: boolean; building: boolean }): boolean {
  return args.allApproved && !args.building
}

export function snapshotProgressLabel(run: { status: string; results: SnapshotRunResults }): string {
  if (run.status === 'queued' || run.status === 'running') return 'Building snapshot…'
  const ingested = run.results.filter((r) => r.status === 'ingested')
  const failed = run.results.filter((r) => r.status === 'failed')
  if (run.status === 'committed') {
    const rows = ingested.reduce((a, r) => a + (r.rowCount ?? 0), 0)
    return `Snapshot built — ${ingested.length} database${ingested.length === 1 ? '' : 's'}, ${rows} rows`
  }
  if (run.status === 'partial') return `${ingested.length} ingested, ${failed.length} failed — snapshot not updated`
  return 'Snapshot build failed — previous data unchanged'
}
