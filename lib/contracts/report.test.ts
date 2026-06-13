// lib/contracts/report.test.ts
import { describe, it, expect } from 'vitest'
import {
  MetricRequestSpecSchema,
  FactSchema,
  FactSheetSchema,
  ClaimAssertionSchema,
  InsightClaimSchema,
  InsightClaimsSchema,
  ReportRunStatusSchema,
  ReportRunResultsSchema,
} from './report'

describe('report contracts', () => {
  it('parses a metric request spec', () => {
    const r = MetricRequestSpecSchema.parse({ metric: 'sum', sourceDatabaseId: 'db1', measureFieldId: 'amt' })
    expect(r.metric).toBe('sum')
  })

  it('rejects an unknown metric', () => {
    expect(MetricRequestSpecSchema.safeParse({ metric: 'median', sourceDatabaseId: 'db1' }).success).toBe(false)
  })

  it('parses a scalar fact with a delta', () => {
    const f = FactSchema.parse({
      factId: '3::db1::sum::amt::-::-',
      metricRequest: { metric: 'sum', sourceDatabaseId: 'db1', measureFieldId: 'amt' },
      label: 'Sum of Amount',
      value: 120,
      previousValue: 108,
      delta: { absolute: 12, relative: 0.111 },
      snapshotVersion: 3,
      computedAt: '2026-06-12T00:00:00.000Z',
    })
    expect(f.value).toBe(120)
  })

  it('allows a null fact value (unsupported/empty)', () => {
    const f = FactSchema.parse({
      factId: 'x', metricRequest: { metric: 'average', sourceDatabaseId: 'db1', measureFieldId: 'amt' },
      label: 'Average', value: null, snapshotVersion: 3, computedAt: '2026-06-12T00:00:00.000Z',
    })
    expect(f.value).toBeNull()
  })

  it('discriminates the four assertion kinds', () => {
    expect(ClaimAssertionSchema.parse({ kind: 'value', factId: 'a', expected: 5 }).kind).toBe('value')
    expect(ClaimAssertionSchema.parse({ kind: 'trend', factId: 'a', direction: 'up' }).kind).toBe('trend')
    expect(ClaimAssertionSchema.parse({ kind: 'rank', factId: 'a', groupKey: 'EMEA', position: 'max' }).kind).toBe('rank')
    expect(ClaimAssertionSchema.parse({ kind: 'citation', factIds: ['a'] }).kind).toBe('citation')
  })

  it('requires citation to cite at least one fact', () => {
    expect(ClaimAssertionSchema.safeParse({ kind: 'citation', factIds: [] }).success).toBe(false)
  })

  it('parses an insight claim and a claims envelope', () => {
    const claim = InsightClaimSchema.parse({
      section: 'summary', template: '{groupKey} led with {value}.',
      assertion: { kind: 'rank', factId: 'a', groupKey: 'EMEA', position: 'max' }, severity: 'high',
    })
    expect(claim.section).toBe('summary')
    expect(InsightClaimsSchema.parse({ claims: [claim] }).claims).toHaveLength(1)
  })

  it('enumerates run statuses and validates a results payload', () => {
    expect(ReportRunStatusSchema.options).toEqual(['queued', 'running', 'rewriting', 'committed', 'write_failed', 'failed'])
    const res = ReportRunResultsSchema.parse({ factsConsidered: 10, claimsProposed: 6, claimsVerified: 4, claimsDropped: [{ kind: 'value', reason: 'mismatched' }], empty: false })
    expect(res.claimsVerified).toBe(4)
  })
})
