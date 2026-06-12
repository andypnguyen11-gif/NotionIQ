import { describe, it, expect } from 'vitest'
import { count, sum, avg, min, max, groupBy, bucketByTime } from './primitives'
import type { MetricRecord } from '@/lib/contracts/normalized'

function rec(value: number, region: string, occurredAt: string | null): MetricRecord {
  return {
    occurredAt,
    mappedFields: {
      measures: { amt: { name: 'Amount', value } },
      dimensions: { reg: { name: 'Region', value: region } },
      status: {},
    },
  }
}

const recs: MetricRecord[] = [
  rec(10, 'EMEA', '2026-01-05T00:00:00.000Z'),
  rec(20, 'EMEA', '2026-01-20T00:00:00.000Z'),
  rec(30, 'AMER', '2026-02-03T00:00:00.000Z'),
]

describe('metric primitives', () => {
  it('count/sum/avg/min/max over a measure field', () => {
    expect(count(recs)).toBe(3)
    expect(sum(recs, 'amt')).toBe(60)
    expect(avg(recs, 'amt')).toBe(20)
    expect(min(recs, 'amt')).toBe(10)
    expect(max(recs, 'amt')).toBe(30)
  })

  it('sum ignores records missing the measure', () => {
    expect(sum([...recs, { occurredAt: null, mappedFields: { measures: {}, dimensions: {}, status: {} } }], 'amt')).toBe(60)
  })

  it('groupBy buckets records by a dimension value', () => {
    const g = groupBy(recs, 'reg')
    expect(Object.keys(g).sort()).toEqual(['AMER', 'EMEA'])
    expect(g.EMEA).toHaveLength(2)
  })

  it('bucketByTime groups by month and skips null occurredAt', () => {
    const withNull = [...recs, rec(5, 'EMEA', null)]
    const b = bucketByTime(withNull, 'month')
    expect(Object.keys(b).sort()).toEqual(['2026-01', '2026-02'])
    expect(b['2026-01']).toHaveLength(2)
  })
})
