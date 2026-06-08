import { describe, it, expect } from 'vitest'
import { applyEdits } from './merge'
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'

const proposal: DatabaseMappingProposal = {
  classification: 'sales pipeline',
  occurredAtPropertyId: 'p1',
  fields: [
    { notionPropertyId: 'p1', name: 'Close Date', notionType: 'date', candidateRole: 'date', role: 'date', confidence: 0.9, rationale: 'date' },
    { notionPropertyId: 'p2', name: 'Amount', notionType: 'number', candidateRole: 'measure', role: 'measure', confidence: 0.9, rationale: 'num' },
  ],
  modelVersion: 'm',
  promptVersion: 'mapper-v1',
}

describe('applyEdits', () => {
  it('overrides roles and occurredAt from human edits and validates', () => {
    const out = applyEdits(proposal, { occurredAtPropertyId: 'p1', roles: { p2: 'dimension' } })
    expect(out.fields.find((f) => f.notionPropertyId === 'p2')!.role).toBe('dimension')
  })

  it('rejects an edit for an unknown property', () => {
    expect(() => applyEdits(proposal, { occurredAtPropertyId: 'p1', roles: { pX: 'measure' } })).toThrow(/unknown property/)
  })

  it('rejects an occurredAt that is not a date-role field', () => {
    expect(() => applyEdits(proposal, { occurredAtPropertyId: 'p2', roles: {} })).toThrow(/occurredAt/)
  })
})
