import { describe, it, expect } from 'vitest'
import { normalizeRow } from './normalize-row'
import type { TypedRow } from '@/lib/contracts/normalized'
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'

function field(over: Partial<DatabaseMappingProposal['fields'][number]>) {
  return { notionPropertyId: 'x', name: 'X', notionType: 't', candidateRole: 'ignore', role: 'ignore', confidence: 1, rationale: '', ...over } as DatabaseMappingProposal['fields'][number]
}
function mapping(over: Partial<DatabaseMappingProposal> = {}): DatabaseMappingProposal {
  return { classification: 'sales', occurredAtPropertyId: 'p4', fields: [], modelVersion: 'm', promptVersion: 'p', ...over }
}

const row: TypedRow = {
  notionPageId: 'pg1',
  values: {
    p1: { kind: 'number', value: 1990 },
    p2: { kind: 'text', value: 'EMEA' },
    p3: { kind: 'text', value: 'Won' },
    p4: { kind: 'date', value: '2026-06-12T00:00:00.000Z' },
    p5: { kind: 'text', value: 'Acme renewal' },
  },
}

describe('normalizeRow', () => {
  it('routes each role into its bucket and promotes occurredAt', () => {
    const out = normalizeRow(row, mapping({ fields: [
      field({ notionPropertyId: 'p1', name: 'Amount', role: 'measure' }),
      field({ notionPropertyId: 'p2', name: 'Region', role: 'dimension' }),
      field({ notionPropertyId: 'p3', name: 'Stage', role: 'status' }),
      field({ notionPropertyId: 'p4', name: 'Closed', role: 'date' }),
      field({ notionPropertyId: 'p5', name: 'Name', role: 'title' }),
    ] }))
    expect(out.notionPageId).toBe('pg1')
    expect(out.occurredAt).toBe('2026-06-12T00:00:00.000Z')
    expect(out.mappedFields).toEqual({
      measures: { p1: { name: 'Amount', value: 1990 } },
      dimensions: { p2: { name: 'Region', value: 'EMEA' } },
      status: { p3: { name: 'Stage', value: 'Won' } },
      title: { value: 'Acme renewal' },
    })
    expect(out.warnings).toEqual([])
  })

  it('drops ignore fields', () => {
    const out = normalizeRow(row, mapping({ occurredAtPropertyId: null, fields: [field({ notionPropertyId: 'p1', role: 'ignore' })] }))
    expect(out.mappedFields.measures).toEqual({})
  })

  it('leaves occurredAt null with no warning when the cell is empty', () => {
    const r: TypedRow = { notionPageId: 'pg1', values: { p4: { kind: 'empty' } } }
    const out = normalizeRow(r, mapping({ fields: [] }))
    expect(out.occurredAt).toBeNull()
    expect(out.warnings).toEqual([])
  })

  it('records a warning when occurredAt points at an unparseable date', () => {
    const r: TypedRow = { notionPageId: 'pg1', values: { p4: { kind: 'text', value: 'not-a-date' } } }
    const out = normalizeRow(r, mapping({ fields: [] }))
    expect(out.occurredAt).toBeNull()
    expect(out.warnings).toContain('occurredAt: unparseable date "not-a-date"')
  })

  it('drops an unparseable/empty measure and warns', () => {
    const r: TypedRow = { notionPageId: 'pg1', values: { p1: { kind: 'empty' } } }
    const out = normalizeRow(r, mapping({ occurredAtPropertyId: null, fields: [field({ notionPropertyId: 'p1', name: 'Amount', role: 'measure' })] }))
    expect(out.mappedFields.measures).toEqual({})
    expect(out.warnings).toContain('measure Amount: missing or non-numeric value')
  })
})
