// lib/agents/insight.ts
import { InsightClaimsSchema, type FactSheet, type InsightClaim } from '@/lib/contracts/report'
import type { ToolCaller } from './anthropic-client'
import { log } from '@/lib/log'

export const PROMPT_VERSION = 'insight-v2'
const TOOL_NAME = 'emit_report'

export interface InsightContext {
  databases: { sourceDatabaseId: string; classification: string }[]
}
export interface InsightResult {
  claims: InsightClaim[]
  inputTokens: number
  outputTokens: number
  model: string
  promptVersion: string
}

const toolSchema = {
  type: 'object',
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        required: ['section', 'template', 'assertion'],
        properties: {
          section: { enum: ['summary', 'metric', 'trend', 'warning', 'recommendation'] },
          template: { type: 'string' },
          severity: { enum: ['low', 'med', 'high'] },
          assertion: { type: 'object' },
        },
      },
    },
  },
} as const

const SYSTEM = [
  'You are a business analyst writing a report from a fact sheet of pre-computed metrics.',
  'You MUST NOT write any number yourself. Reference a fact by its factId and assert what it shows;',
  'the system fills numbers from the engine. In templates, use ONLY these placeholders:',
  '{value} {previousValue} {delta.absolute} {delta.relative} {groupKey}. No other placeholder and no literal numbers.',
  'NEVER write a literal digit anywhere in template prose (not even in words like "Q4" or "2026");',
  'every number a reader sees must come solely from one of the allowed placeholders. A template whose prose contains any digit is rejected.',
  'Each claim has a section, a template sentence, and a structured assertion:',
  "value {factId, expected}, trend {factId, direction}, rank {factId, groupKey, position}, or citation {factIds}.",
  'Recommendations MUST use a citation assertion that cites at least one factId and contain no placeholders.',
  'Only assert what the facts support. Prefer fewer, well-evidenced claims over many.',
].join(' ')

function buildUser(factSheet: FactSheet, context: InsightContext): string {
  return JSON.stringify({ databases: context.databases, facts: factSheet.facts })
}

async function callOnce(deps: { toolCaller: ToolCaller; model: string }, user: string): Promise<InsightResult> {
  const res = await deps.toolCaller.callTool({ system: SYSTEM, user, toolName: TOOL_NAME, toolSchema, model: deps.model })
  const parsed = InsightClaimsSchema.safeParse(res.input)
  if (!parsed.success) {
    log.error('insight_invalid_output', { model: deps.model, promptVersion: PROMPT_VERSION })
    throw Object.assign(new Error('insight output failed validation'), { code: 'INSIGHT_INVALID_OUTPUT' })
  }
  log.info('insight_ok', { model: res.model, promptVersion: PROMPT_VERSION, inputTokens: res.inputTokens, outputTokens: res.outputTokens, claimCount: parsed.data.claims.length })
  return { claims: parsed.data.claims, inputTokens: res.inputTokens, outputTokens: res.outputTokens, model: res.model, promptVersion: PROMPT_VERSION }
}

export async function draftInsights(deps: { toolCaller: ToolCaller; model: string }, input: { factSheet: FactSheet; context: InsightContext }): Promise<InsightResult> {
  return callOnce(deps, buildUser(input.factSheet, input.context))
}

export async function repairInsights(
  deps: { toolCaller: ToolCaller; model: string },
  input: { factSheet: FactSheet; context: InsightContext; failures: { template: string; reason: string }[] },
): Promise<InsightResult> {
  const user = [
    buildUser(input.factSheet, input.context),
    '\n\nThese claims failed verification — fix or drop them, and return the FULL corrected claim set:',
    JSON.stringify(input.failures),
  ].join('')
  return callOnce(deps, user)
}
