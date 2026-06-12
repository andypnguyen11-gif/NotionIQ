import type { TypedValue, NormalizedRecordInput, MappedFields } from '@/lib/contracts/normalized'
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'

// Pure: route each approved field's typed value into its mappedFields bucket and promote
// occurredAt. Deterministic; no Notion, no DB. Collects warnings instead of throwing.
export function normalizeRow(
  row: { notionPageId: string; values: Record<string, TypedValue> },
  mapping: DatabaseMappingProposal,
): NormalizedRecordInput {
  const warnings: string[] = []
  const mappedFields: MappedFields = { measures: {}, dimensions: {}, status: {} }

  for (const f of mapping.fields) {
    const cell = row.values[f.notionPropertyId]
    if (!cell) continue
    switch (f.role) {
      case 'measure': {
        if (cell.kind === 'number') mappedFields.measures[f.notionPropertyId] = { name: f.name, value: cell.value }
        else warnings.push(`measure ${f.name}: missing or non-numeric value`)
        break
      }
      case 'dimension': {
        const s = asString(cell)
        if (s !== null) mappedFields.dimensions[f.notionPropertyId] = { name: f.name, value: s }
        break
      }
      case 'status': {
        const s = asString(cell)
        if (s !== null) mappedFields.status[f.notionPropertyId] = { name: f.name, value: s }
        break
      }
      case 'title': {
        if (cell.kind === 'text') mappedFields.title = { value: cell.value }
        break
      }
      // 'date' and 'ignore' are not stored in mappedFields; the timeline is promoted below.
      default:
        break
    }
  }

  const occurredAt = mapping.occurredAtPropertyId
    ? coerceDate(row.values[mapping.occurredAtPropertyId], warnings)
    : null

  return { notionPageId: row.notionPageId, occurredAt, mappedFields, warnings }
}

function asString(cell: TypedValue): string | null {
  if (cell.kind === 'text') return cell.value
  if (cell.kind === 'list') return cell.value.join(', ')
  if (cell.kind === 'number') return String(cell.value)
  if (cell.kind === 'date') return cell.value
  return null
}

function coerceDate(cell: TypedValue | undefined, warnings: string[]): string | null {
  if (!cell || cell.kind === 'empty') return null
  if (cell.kind === 'date') return cell.value // already UTC ISO from the reader
  const raw = cell.kind === 'text' ? cell.value : null
  if (raw === null) {
    warnings.push('occurredAt: source field is not a date')
    return null
  }
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) {
    warnings.push(`occurredAt: unparseable date "${raw}"`)
    return null
  }
  return d.toISOString()
}
