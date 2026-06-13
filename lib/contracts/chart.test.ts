import { describe, it, expect } from 'vitest'
import {
  ChartConfigSchema,
  ChartDataContractSchema,
  MetricRequestSchema,
  CHART_CONTRACT_VERSION,
} from './chart'

describe('MetricRequestSchema', () => {
  it('accepts count with no measure', () => {
    expect(MetricRequestSchema.safeParse({ metric: 'count' }).success).toBe(true)
  })
  it('rejects sum without a measureFieldId', () => {
    expect(MetricRequestSchema.safeParse({ metric: 'sum' }).success).toBe(false)
  })
  it('rejects revenue without a classification', () => {
    expect(MetricRequestSchema.safeParse({ metric: 'revenue', measureFieldId: 'm1' }).success).toBe(false)
  })
  it('accepts revenue with measure + classification', () => {
    expect(MetricRequestSchema.safeParse({ metric: 'revenue', measureFieldId: 'm1', classification: 'sales' }).success).toBe(true)
  })
})

describe('ChartConfigSchema', () => {
  it('defaults categorical topN to 20 and renderer to bar', () => {
    const parsed = ChartConfigSchema.parse({
      shape: 'categorical',
      metric: { metric: 'count' },
      groupByFieldId: 'd1',
      groupByKind: 'dimension',
    })
    expect(parsed).toMatchObject({ topN: 20, renderer: 'bar' })
  })
  it('rejects topN above 50', () => {
    const r = ChartConfigSchema.safeParse({
      shape: 'categorical', metric: { metric: 'count' }, groupByFieldId: 'd1', groupByKind: 'dimension', topN: 51,
    })
    expect(r.success).toBe(false)
  })
  it('requires groupByKind for categorical', () => {
    const r = ChartConfigSchema.safeParse({ shape: 'categorical', metric: { metric: 'count' }, groupByFieldId: 'd1' })
    expect(r.success).toBe(false)
  })
  it('accepts a timeseries config', () => {
    const r = ChartConfigSchema.safeParse({ shape: 'timeseries', metric: { metric: 'count' }, bucket: 'month' })
    expect(r.success).toBe(true)
  })
  it('accepts a kpi config', () => {
    expect(ChartConfigSchema.safeParse({ shape: 'kpi', metric: { metric: 'count' } }).success).toBe(true)
  })
})

describe('ChartDataContractSchema', () => {
  it('round-trips a categorical data contract', () => {
    const contract = {
      kind: 'data', version: CHART_CONTRACT_VERSION, snapshotVersion: 3, shape: 'categorical',
      points: [{ label: 'A', value: 5 }], truncated: false, omittedGroupCount: 0,
    }
    expect(ChartDataContractSchema.parse(contract)).toEqual(contract)
  })
  it('round-trips an unsupported contract', () => {
    const contract = { kind: 'unsupported', version: CHART_CONTRACT_VERSION, reason: 'average of an empty record set' }
    expect(ChartDataContractSchema.parse(contract)).toEqual(contract)
  })
})
