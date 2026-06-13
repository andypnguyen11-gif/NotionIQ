import type { ReportRunResults } from '@/lib/contracts/report'

export function reportCtaLabel(hasReport: boolean): string {
  return hasReport ? 'Refresh AI Business Review' : 'Generate AI Business Review'
}

export function canGenerateReport(args: { hasCommittedSnapshot: boolean; running: boolean }): boolean {
  return args.hasCommittedSnapshot && !args.running
}

export function reportProgressLabel(run: { status: string; results: ReportRunResults | null }): string {
  if (run.status === 'queued' || run.status === 'running') return 'Generating report…'
  if (run.status === 'rewriting') return 'Publishing report…'
  if (run.status === 'committed') {
    if (run.results?.empty) return 'Report published — not enough verified data this run'
    const n = run.results?.claimsVerified ?? 0
    return `Report published — ${n} verified claim${n === 1 ? '' : 's'}`
  }
  if (run.status === 'write_failed') return 'Report ready but publishing failed — retry publish'
  return 'Report generation failed'
}
