import { z } from 'zod'

// A single typed Notion cell — discriminated on `kind` for safe extraction + normalization.
export const TypedValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('number'), value: z.number() }),
  z.object({ kind: z.literal('text'), value: z.string() }), // select, status, title, rich_text
  z.object({ kind: z.literal('list'), value: z.array(z.string()) }), // multi_select, relation, people
  z.object({ kind: z.literal('date'), value: z.string() }), // full ISO 8601 datetime, UTC
  z.object({ kind: z.literal('empty') }), // null/absent cell
])
export type TypedValue = z.infer<typeof TypedValueSchema>

// One full Notion row, values keyed by Notion property id (matches mapping.notionPropertyId).
export const TypedRowSchema = z.object({
  notionPageId: z.string().min(1),
  values: z.record(z.string(), TypedValueSchema),
})
export type TypedRow = z.infer<typeof TypedRowSchema>

const NamedNumber = z.object({ name: z.string(), value: z.number() })
const NamedString = z.object({ name: z.string(), value: z.string() })

// The persisted JSONB shape. Buckets default to empty so reads never crash on a sparse row.
export const MappedFieldsSchema = z.object({
  measures: z.record(z.string(), NamedNumber).default({}),
  dimensions: z.record(z.string(), NamedString).default({}),
  status: z.record(z.string(), NamedString).default({}),
  title: z.object({ value: z.string() }).optional(),
})
export type MappedFields = z.infer<typeof MappedFieldsSchema>

export const NormalizedRecordInputSchema = z.object({
  notionPageId: z.string().min(1),
  occurredAt: z.string().nullable(),
  mappedFields: MappedFieldsSchema,
  warnings: z.array(z.string()),
})
export type NormalizedRecordInput = z.infer<typeof NormalizedRecordInputSchema>

// The engine's read view of a stored record (decoupled from Prisma).
export interface MetricRecord {
  occurredAt: string | null
  mappedFields: MappedFields
}
