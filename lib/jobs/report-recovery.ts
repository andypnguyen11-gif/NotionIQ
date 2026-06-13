import type { ReportRunStatus } from '@/lib/contracts/report'

// A run left in an active status by a hard kill must be freed (frees the single-flight slot).
// D-8: once claims are persisted, a failure must land in 'write_failed' (claims intact, write-only
// retry available), never 'failed' (which strands the verified claims with no retry path).
// running/queued -> write_failed if claims were already persisted, else failed.
// rewriting -> write_failed (claims + report intact; the user can re-trigger the write-only retry).
// Terminal -> null (leave as-is).
export function recoveryStatusFor(current: string, hasPersistedClaims: boolean): ReportRunStatus | null {
  if (current === 'running' || current === 'queued') return hasPersistedClaims ? 'write_failed' : 'failed'
  if (current === 'rewriting') return 'write_failed'
  return null
}
