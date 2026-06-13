// lib/agents/insight.test.ts
import { describe, it, expect, vi } from 'vitest'
import { draftInsights, repairInsights, PROMPT_VERSION } from './insight'
import type { ToolCaller } from './anthropic-client'
import type { FactSheet } from '@/lib/contracts/report'

const sheet: FactSheet = {
  snapshotVersion: 3, generatedAt: 't',
  facts: [{ factId: 'f_sum', metricRequest: { metric: 'sum', sourceDatabaseId: 'db1', measureFieldId: 'amt' }, label: 'Sum', value: 120, snapshotVersion: 3, computedAt: 't' }],
}
const context = { databases: [{ sourceDatabaseId: 'db1', classification: 'sales' }] }
const validClaim = { section: 'metric', template: 'Total {value}.', assertion: { kind: 'value', factId: 'f_sum', expected: 120 } }

function caller(input: unknown): ToolCaller {
  return { callTool: vi.fn(async () => ({ input, model: 'claude-sonnet-4-6', inputTokens: 10, outputTokens: 5 })) }
}

describe('insight agent', () => {
  it('drafts claims from the fact sheet', async () => {
    const toolCaller = caller({ claims: [validClaim] })
    const res = await draftInsights({ toolCaller, model: 'claude-sonnet-4-6' }, { factSheet: sheet, context })
    expect(res.claims).toHaveLength(1)
    expect(res.outputTokens).toBe(5)
    expect(res.promptVersion).toBe(PROMPT_VERSION)
  })

  it('throws a typed error when the model output is invalid', async () => {
    const toolCaller = caller({ claims: [{ section: 'nope', template: '', assertion: {} }] })
    await expect(draftInsights({ toolCaller, model: 'm' }, { factSheet: sheet, context })).rejects.toMatchObject({ code: 'INSIGHT_INVALID_OUTPUT' })
  })

  it('repair sends the failures back and validates the repaired output', async () => {
    const toolCaller = caller({ claims: [validClaim] })
    const res = await repairInsights({ toolCaller, model: 'm' }, { factSheet: sheet, context, failures: [{ template: 'bad', reason: 'mismatched' }] })
    expect(res.claims).toHaveLength(1)
    const callArg = (toolCaller.callTool as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArg.user).toMatch(/mismatched/)
  })
})
