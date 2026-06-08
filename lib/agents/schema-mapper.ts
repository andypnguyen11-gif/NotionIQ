import { DatabaseMappingProposalSchema, type DatabaseMappingProposal } from '@/lib/contracts/mapping'
import { candidateRole } from '@/lib/mapping/candidate-rules'
import { BOUNDS } from '@/lib/notion/sample-bounds'
import type { ScannedDatabase } from '@/lib/notion/scanner'
import type { ToolCaller } from './anthropic-client'
import { log } from '@/lib/log'

export const PROMPT_VERSION = 'mapper-v1'
const TOOL_NAME = 'emit_mapping'

export interface MapResult { proposal: DatabaseMappingProposal; inputTokens: number; outputTokens: number; model: string }

const toolSchema = {
  type: 'object',
  required: ['classification', 'occurredAtPropertyId', 'fields'],
  properties: {
    classification: { type: 'string' },
    occurredAtPropertyId: { type: ['string', 'null'] },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        required: ['notionPropertyId', 'name', 'notionType', 'candidateRole', 'role', 'confidence', 'rationale'],
        properties: {
          notionPropertyId: { type: 'string' },
          name: { type: 'string' },
          notionType: { type: 'string' },
          candidateRole: { enum: ['date', 'measure', 'dimension', 'status', 'title', 'ignore'] },
          role: { enum: ['date', 'measure', 'dimension', 'status', 'title', 'ignore'] },
          confidence: { type: 'number' },
          rationale: { type: 'string' },
        },
      },
    },
  },
} as const

function buildUserPrompt(db: ScannedDatabase): string {
  const props = db.properties.slice(0, BOUNDS.MAX_PROPERTIES).map((p) => ({
    id: p.id,
    name: p.name,
    notionType: p.notionType,
    candidateRole: candidateRole({ notionType: p.notionType }),
    optionNames: p.optionNames?.slice(0, BOUNDS.MAX_OPTION_NAMES),
  }))
  return JSON.stringify({ databaseName: db.databaseName, properties: props, sample: db.sample })
}

const SYSTEM = [
  'You classify a Notion database and assign each property one role:',
  'date, measure, dimension, status, title, or ignore.',
  'candidateRole is a deterministic prior from the Notion type; keep it unless the data clearly says otherwise.',
  'Choose exactly one occurredAtPropertyId (the timeline) from the date properties, or null if none.',
  'rationale MUST reference only property names, Notion types, and option names — NEVER any value from the sample rows.',
  'Keep each rationale under 200 characters.',
].join(' ')

// Build the schema vocabulary used to detect rationale leakage (best-effort secondary net).
function schemaVocabulary(db: ScannedDatabase): Set<string> {
  const v = new Set<string>()
  for (const p of db.properties) {
    p.name.toLowerCase().split(/\W+/).filter(Boolean).forEach((t) => v.add(t))
    v.add(p.notionType.toLowerCase())
    p.optionNames?.forEach((o) => o.toLowerCase().split(/\W+/).filter(Boolean).forEach((t) => v.add(t)))
  }
  return v
}

function sampleTokens(db: ScannedDatabase): Set<string> {
  const v = new Set<string>()
  for (const row of db.sample)
    for (const val of Object.values(row.values))
      val.toLowerCase().split(/\W+/).filter(Boolean).forEach((t) => v.add(t))
  return v
}

function scrubRationales(proposal: DatabaseMappingProposal, db: ScannedDatabase): DatabaseMappingProposal {
  const vocab = schemaVocabulary(db)
  const sample = sampleTokens(db)
  return {
    ...proposal,
    fields: proposal.fields.map((f) => {
      const tokens = f.rationale.toLowerCase().split(/\W+/).filter(Boolean)
      const leaks = tokens.some((t) => sample.has(t) && !vocab.has(t))
      return leaks ? { ...f, rationale: '' } : f
    }),
  }
}

export async function mapSchema(
  deps: { toolCaller: ToolCaller; model: string },
  db: ScannedDatabase,
): Promise<MapResult> {
  const user = buildUserPrompt(db)
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await deps.toolCaller.callTool({
      system: SYSTEM,
      user: attempt === 0 ? user : `${user}\n\nYour previous output was invalid: ${lastError}\nReturn valid output.`,
      toolName: TOOL_NAME,
      toolSchema,
      model: deps.model,
    })
    const parsed = DatabaseMappingProposalSchema.safeParse({
      ...(res.input as object),
      modelVersion: res.model,
      promptVersion: PROMPT_VERSION,
    })
    if (parsed.success) {
      log.info('schema_mapper_ok', {
        notionDatabaseId: db.notionDatabaseId,
        model: res.model,
        promptVersion: PROMPT_VERSION,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        fieldCount: parsed.data.fields.length,
      })
      return { proposal: scrubRationales(parsed.data, db), inputTokens: res.inputTokens, outputTokens: res.outputTokens, model: res.model }
    }
    lastError = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  }
  log.error('schema_mapper_invalid', { notionDatabaseId: db.notionDatabaseId, model: deps.model })
  throw Object.assign(new Error('schema mapper output failed validation after repair'), { code: 'MAPPER_INVALID_OUTPUT' })
}
