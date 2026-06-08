import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'

export interface DbResultView { notionDatabaseId: string; status: 'scanned' | 'mapped' | 'failed' }

export function scanProgressLabel(run: { status: string; results: DbResultView[] }): string {
  if (run.status === 'queued' || run.status === 'running') return 'Scanning…'
  const mapped = run.results.filter((r) => r.status === 'mapped').length
  const failed = run.results.filter((r) => r.status === 'failed').length
  return failed > 0 ? `${mapped} mapped, ${failed} failed` : `${mapped} mapped`
}

export function isReviewable(status: string): boolean {
  return status === 'proposed' || status === 'approved'
}

export function lowConfidence(confidence: number): boolean {
  return confidence < 0.6
}

export interface ReviewRow {
  id: string
  name: string
  notionType: string
  optionNames?: string[]
  relationTargetName?: string
  candidateRole: string
  role: string
  confidence: number
  rationale: string
  isOccurredAt: boolean
  flagged: boolean
}

export function fieldRowsForReview(proposal: DatabaseMappingProposal): ReviewRow[] {
  return proposal.fields.map((f) => ({
    id: f.notionPropertyId,
    name: f.name,
    notionType: f.notionType,
    optionNames: f.optionNames,
    relationTargetName: f.relationTargetName,
    candidateRole: f.candidateRole,
    role: f.role,
    confidence: f.confidence,
    rationale: f.rationale,
    isOccurredAt: proposal.occurredAtPropertyId === f.notionPropertyId,
    flagged: lowConfidence(f.confidence),
  }))
}
