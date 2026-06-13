import type { ReportRunStatus } from '@/lib/contracts/report'

// A run left in an active status by a hard kill must be freed (frees the single-flight slot).
// running/queued -> failed (claims not durable). rewriting -> write_failed (claims + report intact;
// the user can re-trigger the write-only retry). Terminal -> null (leave as-is).
export function recoveryStatusFor(current: string): ReportRunStatus | null {
  if (current === 'running' || current === 'queued') return 'failed'
  if (current === 'rewriting') return 'write_failed'
  return null
}
