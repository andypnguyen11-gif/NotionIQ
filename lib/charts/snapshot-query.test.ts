import { describe, it, expect } from 'vitest'
import { aggregate } from './snapshot-query'
import type { MetricRecord } from '@/lib/contracts/normalized'
import type { ChartConfig } from '@/lib/contracts/chart'

const rec = (dim: string | undefined, occurredAt: string | null = null, measure?: number): MetricRecord => ({
  occurredAt,
  mappedFields: {
    measures: measure === undefined ? {} : { m1: { name: 'amt', value: measure } },
    dimensions: dim === undefined ? {} : { d1: { name: 'region', value: dim } },
    status: {},
  },
})

describe('aggregate — categorical', () => {
  const config: ChartConfig = { shape: 'categorical', metric: { metric: 'count' }, groupByFieldId: 'd1', groupByKind: 'dimension', topN: 20, renderer: 'bar' }

  it('counts per group, sorted value desc then label asc', () => {
    const recs = [rec('B'), rec('A'), rec('A'), rec('C'), rec('C')]
    const out = aggregate(recs, config, 4)
    expect(out).toEqual({
      kind: 'data', version: 1, snapshotVersion: 4, shape: 'categorical',
      points: [{ label: 'A', value: 2 }, { label: 'C', value: 2 }, { label: 'B', value: 1 }],
      truncated: false, omittedGroupCount: 0,
    })
  })

  it('labels missing/null group values "(Unspecified)"', () => {
    const out = aggregate([rec(undefined), rec(undefined), rec('A')], config, 1)
    expect(out).toMatchObject({ kind: 'data', points: [{ label: '(Unspecified)', value: 2 }, { label: 'A', value: 1 }] })
  })

  it('truncates to topN with an omitted count', () => {
    const recs = ['A', 'B', 'C', 'D'].flatMap((d, i) => Array.from({ length: 4 - i }, () => rec(d)))
    const out = aggregate(recs, { ...config, topN: 2 }, 1)
    expect(out).toMatchObject({ truncated: true, omittedGroupCount: 2, points: [{ label: 'A', value: 4 }, { label: 'B', value: 3 }] })
  })

  it('returns empty data (not a refusal) for an empty snapshot', () => {
    expect(aggregate([], config, 9)).toEqual({
      kind: 'data', version: 1, snapshotVersion: 9, shape: 'categorical', points: [], truncated: false, omittedGroupCount: 0,
    })
  })
})

describe('aggregate — timeseries', () => {
  const config: ChartConfig = { shape: 'timeseries', metric: { metric: 'count' }, bucket: 'month', renderer: 'line' }

  it('buckets by UTC month, non-empty only, sorted asc; skips null occurredAt', () => {
    const recs = [rec('x', '2026-02-10T00:00:00.000Z'), rec('x', '2026-01-05T00:00:00.000Z'), rec('x', '2026-01-20T00:00:00.000Z'), rec('x', null)]
    const out = aggregate(recs, config, 2)
    expect(out).toEqual({
      kind: 'data', version: 1, snapshotVersion: 2, shape: 'timeseries', granularity: 'month',
      points: [{ bucket: '2026-01', value: 2 }, { bucket: '2026-02', value: 1 }],
    })
  })

  it('returns empty data when every record has null occurredAt', () => {
    expect(aggregate([rec('x', null)], config, 1)).toMatchObject({ kind: 'data', shape: 'timeseries', points: [] })
  })
})

describe('aggregate — kpi', () => {
  it('returns a scalar value for count', () => {
    expect(aggregate([rec('a'), rec('b')], { shape: 'kpi', metric: { metric: 'count' } }, 5)).toEqual({
      kind: 'data', version: 1, snapshotVersion: 5, shape: 'kpi', value: 2,
    })
  })
  it('passes through the engine refusal for average over zero records', () => {
    const out = aggregate([], { shape: 'kpi', metric: { metric: 'average', measureFieldId: 'm1' } }, 5)
    expect(out).toMatchObject({ kind: 'unsupported', version: 1 })
  })
})
