import { describe, it, expect } from 'vitest'
import { TypedValueSchema, MappedFieldsSchema, NormalizedRecordInputSchema } from './normalized'

describe('normalized contracts', () => {
  it('accepts each TypedValue variant', () => {
    for (const v of [
      { kind: 'number', value: 1 },
      { kind: 'text', value: 'x' },
      { kind: 'list', value: ['a', 'b'] },
      { kind: 'date', value: '2026-06-12T00:00:00.000Z' },
      { kind: 'empty' },
    ]) {
      expect(TypedValueSchema.parse(v)).toEqual(v)
    }
  })

  it('rejects a number TypedValue with a string value', () => {
    expect(TypedValueSchema.safeParse({ kind: 'number', value: 'x' }).success).toBe(false)
  })

  it('defaults the mappedFields buckets to empty objects', () => {
    expect(MappedFieldsSchema.parse({})).toEqual({ measures: {}, dimensions: {}, status: {} })
  })

  it('validates a normalized record input', () => {
    const input = {
      notionPageId: 'pg1',
      occurredAt: '2026-06-12T00:00:00.000Z',
      mappedFields: { measures: { f1: { name: 'Amount', value: 10 } }, dimensions: {}, status: {} },
      warnings: [],
    }
    expect(NormalizedRecordInputSchema.parse(input)).toEqual(input)
  })
})
