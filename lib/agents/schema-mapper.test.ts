import { describe, it, expect, vi } from 'vitest'
import { mapSchema, PROMPT_VERSION } from './schema-mapper'
import type { ScannedDatabase } from '@/lib/notion/scanner'

const db: ScannedDatabase = {
  notionDatabaseId: 'db1',
  databaseName: 'Sales',
  properties: [
    { id: 'p1', name: 'Close Date', notionType: 'date' },
    { id: 'p2', name: 'Amount', notionType: 'number' },
    { id: 'p3', name: 'Stage', notionType: 'status', optionNames: ['Lead', 'Won'] },
  ],
  sample: [{ values: { 'Close Date': '2026-01-01', Amount: '1200', Stage: 'Won' } }],
}

const validProposal = {
  classification: 'sales pipeline',
  occurredAtPropertyId: 'p1',
  fields: [
    { notionPropertyId: 'p1', name: 'Close Date', notionType: 'date', candidateRole: 'date', role: 'date', confidence: 0.95, rationale: 'date property' },
    { notionPropertyId: 'p2', name: 'Amount', notionType: 'number', candidateRole: 'measure', role: 'measure', confidence: 0.9, rationale: 'numeric measure' },
    { notionPropertyId: 'p3', name: 'Stage', notionType: 'status', candidateRole: 'status', role: 'status', confidence: 0.8, rationale: 'pipeline stage' },
  ],
  modelVersion: 'claude-sonnet-4-6',
  promptVersion: PROMPT_VERSION,
}

describe('mapSchema', () => {
  it('returns a validated proposal on the first valid tool output', async () => {
    const caller = { callTool: vi.fn(async () => ({ input: validProposal, model: 'claude-sonnet-4-6', inputTokens: 5, outputTokens: 6 })) }
    const out = await mapSchema({ toolCaller: caller, model: 'claude-sonnet-4-6' }, db)
    expect(out.proposal.occurredAtPropertyId).toBe('p1')
    expect(caller.callTool).toHaveBeenCalledTimes(1)
  })

  it('repairs once on an invalid output then succeeds', async () => {
    const caller = {
      callTool: vi
        .fn()
        .mockResolvedValueOnce({ input: { bad: true }, model: 'm', inputTokens: 1, outputTokens: 1 })
        .mockResolvedValueOnce({ input: validProposal, model: 'm', inputTokens: 1, outputTokens: 1 }),
    }
    const out = await mapSchema({ toolCaller: caller, model: 'm' }, db)
    expect(caller.callTool).toHaveBeenCalledTimes(2)
    expect(out.proposal.classification).toBe('sales pipeline')
  })

  it('throws a tagged error after the repair also fails', async () => {
    const caller = { callTool: vi.fn(async () => ({ input: { bad: true }, model: 'm', inputTokens: 1, outputTokens: 1 })) }
    await expect(mapSchema({ toolCaller: caller, model: 'm' }, db)).rejects.toMatchObject({ code: 'MAPPER_INVALID_OUTPUT' })
  })

  it('drops a rationale that leaks a sample-only token', async () => {
    const leaky = JSON.parse(JSON.stringify(validProposal))
    leaky.fields[1].rationale = 'amount like 1200 here' // "1200" is sample-only, not schema vocab
    const caller = { callTool: vi.fn(async () => ({ input: leaky, model: 'm', inputTokens: 1, outputTokens: 1 })) }
    const out = await mapSchema({ toolCaller: caller, model: 'm' }, db)
    expect(out.proposal.fields[1].rationale).toBe('')
  })
})
