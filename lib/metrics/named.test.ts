import { describe, it, expect } from 'vitest'
import { resolveNamedMetric } from './named'
import type { MetricRecord } from '@/lib/contracts/normalized'

function rec(value: number): MetricRecord {
  return { occurredAt: null, mappedFields: { measures: { amt: { name: 'Amount', value } }, dimensions: {}, status: {} } }
}
const recs = [rec(10), rec(20)]

describe('resolveNamedMetric', () => {
  it('count is always supported', () => {
    expect(resolveNamedMetric(recs, { metric: 'count' })).toEqual({ kind: 'value', value: 2 })
  })

  it('sum resolves with exactly one measure field', () => {
    expect(resolveNamedMetric(recs, { metric: 'sum', measureFieldIds: ['amt'] })).toEqual({ kind: 'value', value: 30 })
  })

  it('sum refuses when the measure is ambiguous (zero or many)', () => {
    expect(resolveNamedMetric(recs, { metric: 'sum', measureFieldIds: [] }).kind).toBe('unsupported')
    expect(resolveNamedMetric(recs, { metric: 'sum', measureFieldIds: ['a', 'b'] }).kind).toBe('unsupported')
  })

  it('average refuses on an empty record set', () => {
    expect(resolveNamedMetric([], { metric: 'average', measureFieldIds: ['amt'] }).kind).toBe('unsupported')
  })

  it('revenue resolves only with a lone measure AND a classification', () => {
    expect(resolveNamedMetric(recs, { metric: 'revenue', measureFieldIds: ['amt'], classification: 'sales' })).toEqual({ kind: 'value', value: 30 })
    expect(resolveNamedMetric(recs, { metric: 'revenue', measureFieldIds: ['amt'] }).kind).toBe('unsupported')
  })
})
