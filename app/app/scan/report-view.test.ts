import { describe, it, expect } from 'vitest'
import { reportCtaLabel, canGenerateReport, reportProgressLabel } from './report-view'

describe('report-view', () => {
  it('labels the CTA based on whether a report already exists', () => {
    expect(reportCtaLabel(false)).toBe('Generate AI Business Review')
    expect(reportCtaLabel(true)).toBe('Refresh AI Business Review')
  })

  it('can generate only with a committed snapshot and not while running', () => {
    expect(canGenerateReport({ hasCommittedSnapshot: true, running: false })).toBe(true)
    expect(canGenerateReport({ hasCommittedSnapshot: false, running: false })).toBe(false)
    expect(canGenerateReport({ hasCommittedSnapshot: true, running: true })).toBe(false)
  })

  it('renders progress per status', () => {
    expect(reportProgressLabel({ status: 'queued', results: null })).toBe('Generating report…')
    expect(reportProgressLabel({ status: 'rewriting', results: null })).toBe('Publishing report…')
    expect(reportProgressLabel({ status: 'committed', results: { factsConsidered: 5, claimsProposed: 4, claimsVerified: 3, claimsDropped: [], empty: false } })).toBe('Report published — 3 verified claims')
    expect(reportProgressLabel({ status: 'committed', results: { factsConsidered: 5, claimsProposed: 4, claimsVerified: 0, claimsDropped: [], empty: true } })).toBe('Report published — not enough verified data this run')
    expect(reportProgressLabel({ status: 'write_failed', results: null })).toBe('Report ready but publishing failed — retry publish')
    expect(reportProgressLabel({ status: 'failed', results: null })).toBe('Report generation failed')
  })
})
