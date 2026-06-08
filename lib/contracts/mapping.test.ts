import { describe, it, expect } from 'vitest'
import { RoleSchema, FieldMappingSchema, DatabaseMappingProposalSchema } from './mapping'

const field = {
  notionPropertyId: 'p1',
  name: 'Amount',
  notionType: 'number',
  candidateRole: 'measure',
  role: 'measure',
  confidence: 0.9,
  rationale: 'Numeric property typically aggregated.',
}

describe('mapping contract', () => {
  it('accepts the lean roles', () => {
    for (const r of ['date', 'measure', 'dimension', 'status', 'title', 'ignore'])
      expect(RoleSchema.parse(r)).toBe(r)
  })

  it('rejects an unknown role', () => {
    expect(() => RoleSchema.parse('person')).toThrow()
  })

  it('rejects a rationale longer than 200 chars', () => {
    expect(() => FieldMappingSchema.parse({ ...field, rationale: 'x'.repeat(201) })).toThrow()
  })

  it('accepts a full proposal', () => {
    const proposal = {
      classification: 'sales pipeline',
      occurredAtPropertyId: 'p9',
      fields: [field],
      modelVersion: 'claude-sonnet-4-6',
      promptVersion: 'mapper-v1',
    }
    expect(DatabaseMappingProposalSchema.parse(proposal).fields.length).toBe(1)
  })

  it('accepts a proposal with no timeline field (occurredAtPropertyId null)', () => {
    const proposal = {
      classification: 'reference table',
      occurredAtPropertyId: null,
      fields: [field],
      modelVersion: 'claude-sonnet-4-6',
      promptVersion: 'mapper-v1',
    }
    expect(DatabaseMappingProposalSchema.parse(proposal).occurredAtPropertyId).toBeNull()
  })
})
