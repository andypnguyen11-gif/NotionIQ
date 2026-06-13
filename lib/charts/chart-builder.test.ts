import { describe, it, expect } from 'vitest'
import { buildChart } from './chart-builder'
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'

const field = (id: string, role: string) => ({
  notionPropertyId: id,
  name: id,
  notionType: 'x',
  candidateRole: role,
  role,
  confidence: 1,
  rationale: 'r',
})
const mapping = (occurredAt: string | null = 'p_date'): DatabaseMappingProposal =>
  ({
    classification: 'sales',
    occurredAtPropertyId: occurredAt,
    fields: [field('p_region', 'dimension'), field('p_stage', 'status'), field('p_amt', 'measure')],
    modelVersion: 'm',
    promptVersion: 'p',
  }) as DatabaseMappingProposal

describe('buildChart', () => {
  it('builds a categorical config and resolves groupByKind=dimension', () => {
    const r = buildChart(mapping(), { shape: 'categorical', metric: 'count', groupByFieldId: 'p_region' })
    expect(r).toEqual({
      kind: 'chart',
      config: {
        shape: 'categorical',
        metric: { metric: 'count' },
        groupByFieldId: 'p_region',
        groupByKind: 'dimension',
        topN: 20,
        renderer: 'bar',
      },
    })
  })

  it('resolves groupByKind=status for a status field', () => {
    const r = buildChart(mapping(), { shape: 'categorical', metric: 'count', groupByFieldId: 'p_stage' })
    expect(r).toMatchObject({ kind: 'chart', config: { groupByKind: 'status' } })
  })

  it('refuses categorical when the groupBy field is a measure (wrong role)', () => {
    const r = buildChart(mapping(), { shape: 'categorical', metric: 'count', groupByFieldId: 'p_amt' })
    expect(r).toMatchObject({ kind: 'unsupported' })
  })

  it('refuses sum without a measure field', () => {
    expect(buildChart(mapping(), { shape: 'kpi', metric: 'sum' })).toMatchObject({ kind: 'unsupported' })
  })

  it('refuses sum when the measure field is not measure-role', () => {
    expect(buildChart(mapping(), { shape: 'kpi', metric: 'sum', measureFieldId: 'p_region' })).toMatchObject({
      kind: 'unsupported',
    })
  })

  it('bakes classification into the metric for revenue', () => {
    const r = buildChart(mapping(), { shape: 'kpi', metric: 'revenue', measureFieldId: 'p_amt' })
    expect(r).toMatchObject({
      kind: 'chart',
      config: { metric: { metric: 'revenue', measureFieldId: 'p_amt', classification: 'sales' } },
    })
  })

  it('refuses timeseries when the mapping has no occurredAt', () => {
    expect(buildChart(mapping(null), { shape: 'timeseries', metric: 'count', bucket: 'month' })).toMatchObject({
      kind: 'unsupported',
    })
  })

  it('builds a timeseries config when occurredAt is mapped', () => {
    expect(buildChart(mapping(), { shape: 'timeseries', metric: 'count', bucket: 'week' })).toMatchObject({
      kind: 'chart',
      config: { shape: 'timeseries', bucket: 'week', renderer: 'line' },
    })
  })

  it('refuses average without a measure field (same rule as sum)', () => {
    expect(buildChart(mapping(), { shape: 'kpi', metric: 'average' })).toMatchObject({ kind: 'unsupported' })
  })

  it('refuses revenue without a measure field', () => {
    expect(buildChart(mapping(), { shape: 'kpi', metric: 'revenue' })).toMatchObject({ kind: 'unsupported' })
  })

  it('refuses categorical when groupByFieldId is not present in the mapping at all', () => {
    expect(buildChart(mapping(), { shape: 'categorical', metric: 'count', groupByFieldId: 'p_missing' })).toMatchObject({ kind: 'unsupported' })
  })

  it('passes a caller-supplied topN through, overriding the default', () => {
    const r = buildChart(mapping(), { shape: 'categorical', metric: 'count', groupByFieldId: 'p_region', topN: 5 })
    expect(r).toMatchObject({ kind: 'chart', config: { topN: 5 } })
  })

  it('refuses an out-of-range topN with a clear reason', () => {
    const r = buildChart(mapping(), { shape: 'categorical', metric: 'count', groupByFieldId: 'p_region', topN: 51 })
    expect(r).toMatchObject({ kind: 'unsupported', reason: 'topN must be an integer between 1 and 50' })
  })

  it('passes renderer=pie through for categorical', () => {
    const r = buildChart(mapping(), { shape: 'categorical', metric: 'count', groupByFieldId: 'p_region', renderer: 'pie' })
    expect(r).toMatchObject({ kind: 'chart', config: { renderer: 'pie' } })
  })
})
