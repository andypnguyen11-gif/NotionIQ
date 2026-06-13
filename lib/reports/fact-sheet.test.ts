// lib/reports/fact-sheet.test.ts
import { describe, it, expect } from 'vitest'
import { factId, computeFact, buildFactSheet } from './fact-sheet'
import type { MetricRecord } from '@/lib/contracts/normalized'
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'

function rec(amt: number, region: string): MetricRecord {
  return { occurredAt: null, mappedFields: { measures: { amt: { name: 'Amount', value: amt } }, dimensions: { reg: { name: 'Region', value: region } }, status: {} } }
}

const mapping: DatabaseMappingProposal = {
  classification: 'sales',
  occurredAtPropertyId: null,
  fields: [
    { notionPropertyId: 'amt', name: 'Amount', notionType: 'number', candidateRole: 'measure', role: 'measure', confidence: 1, rationale: '' },
    { notionPropertyId: 'reg', name: 'Region', notionType: 'select', candidateRole: 'dimension', role: 'dimension', confidence: 1, rationale: '' },
  ],
  modelVersion: 'm', promptVersion: 'p',
}

describe('fact-sheet', () => {
  it('factId is deterministic and encodes the request + version', () => {
    const req = { metric: 'sum' as const, sourceDatabaseId: 'db1', measureFieldId: 'amt' }
    expect(factId(req, 3)).toBe('3::db1::sum::amt::-::-')
    expect(factId(req, 3)).toBe(factId({ ...req }, 3))
  })

  it('computeFact returns a scalar with a previous-snapshot delta', () => {
    const f = computeFact(
      { metric: 'sum', sourceDatabaseId: 'db1', measureFieldId: 'amt' },
      { current: [rec(10, 'EMEA'), rec(20, 'AMER')], previous: [rec(8, 'EMEA'), rec(20, 'AMER')] },
      3, '2026-06-12T00:00:00.000Z',
    )
    expect(f.value).toBe(30)
    expect(f.previousValue).toBe(28)
    expect(f.delta?.absolute).toBe(2)
    expect(f.delta?.relative).toBeCloseTo(2 / 28, 5)
  })

  it('computeFact returns null for average of an empty set (not renderable)', () => {
    const f = computeFact({ metric: 'average', sourceDatabaseId: 'db1', measureFieldId: 'amt' }, { current: [], previous: [] }, 3, 't')
    expect(f.value).toBeNull()
    expect(f.delta).toBeUndefined()
  })

  it('computeFact returns ranked, capped groups for a grouped sum', () => {
    const f = computeFact(
      { metric: 'sum', sourceDatabaseId: 'db1', measureFieldId: 'amt', groupByDimensionId: 'reg' },
      { current: [rec(10, 'EMEA'), rec(20, 'EMEA'), rec(5, 'AMER')], previous: [] },
      3, 't',
    )
    expect(f.groups).toEqual([{ key: 'EMEA', value: 30 }, { key: 'AMER', value: 5 }])
  })

  it('buildFactSheet enumerates count + per-measure scalars + grouped sums, omits delta with no previous', () => {
    const sheet = buildFactSheet(
      [{ sourceDatabaseId: 'db1', mapping, current: [rec(10, 'EMEA'), rec(20, 'AMER')], previous: [] }],
      3, '2026-06-12T00:00:00.000Z',
    )
    const kinds = sheet.facts.map((f) => f.metricRequest.metric)
    expect(kinds).toContain('count')
    expect(kinds).toContain('sum')
    expect(kinds).toContain('average')
    // a grouped sum fact exists
    expect(sheet.facts.some((f) => f.metricRequest.groupByDimensionId === 'reg')).toBe(true)
    // no previous snapshot -> no deltas
    expect(sheet.facts.every((f) => f.delta === undefined)).toBe(true)
  })

  it('buildFactSheet skips a dimension over the cardinality cap and bounds total facts', () => {
    const many: MetricRecord[] = Array.from({ length: 30 }, (_, i) => rec(i, `r${i}`))
    const sheet = buildFactSheet(
      [{ sourceDatabaseId: 'db1', mapping, current: many, previous: [] }],
      3, 't', { maxDimensionCardinality: 20, maxFacts: 5 },
    )
    expect(sheet.facts.length).toBeLessThanOrEqual(5)
    // 'reg' has 30 distinct values > cap 20 -> no grouped fact for it
    expect(sheet.facts.some((f) => f.metricRequest.groupByDimensionId === 'reg')).toBe(false)
  })
})
