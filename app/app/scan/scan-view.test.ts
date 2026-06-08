import { describe, it, expect } from 'vitest'
import { scanProgressLabel, isReviewable, fieldRowsForReview, lowConfidence } from './scan-view'

describe('scan-view', () => {
  it('summarizes per-db results', () => {
    expect(scanProgressLabel({ status: 'running', results: [] })).toBe('Scanning…')
    expect(scanProgressLabel({ status: 'proposed', results: [
      { notionDatabaseId: 'a', status: 'mapped' },
      { notionDatabaseId: 'b', status: 'failed' },
    ] })).toBe('1 mapped, 1 failed')
  })

  it('is reviewable only once proposed or approved', () => {
    expect(isReviewable('queued')).toBe(false)
    expect(isReviewable('proposed')).toBe(true)
    expect(isReviewable('approved')).toBe(true)
  })

  it('flags low confidence fields under 0.6', () => {
    expect(lowConfidence(0.5)).toBe(true)
    expect(lowConfidence(0.8)).toBe(false)
  })

  it('builds review rows with schema context, no sample values', () => {
    const rows = fieldRowsForReview({
      classification: 'sales', occurredAtPropertyId: 'p1', modelVersion: 'm', promptVersion: 'v',
      fields: [{ notionPropertyId: 'p1', name: 'Close Date', notionType: 'date', candidateRole: 'date', role: 'date', confidence: 0.9, rationale: 'date' }],
    })
    expect(rows[0]).toMatchObject({ id: 'p1', name: 'Close Date', notionType: 'date', role: 'date', isOccurredAt: true })
  })
})
