import type { MetricRecord } from '@/lib/contracts/normalized'

const measureValues = (records: MetricRecord[], fieldId: string): number[] =>
  records.map((r) => r.mappedFields.measures[fieldId]?.value).filter((v): v is number => typeof v === 'number')

export const count = (records: MetricRecord[]): number => records.length

export const sum = (records: MetricRecord[], fieldId: string): number =>
  measureValues(records, fieldId).reduce((a, b) => a + b, 0)

export function avg(records: MetricRecord[], fieldId: string): number {
  const vals = measureValues(records, fieldId)
  return vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length
}

// Fold rather than spread (Math.min(...vals)): the engine reads the full committed snapshot,
// and spreading tens of thousands of args overflows the call stack (RangeError).
export function min(records: MetricRecord[], fieldId: string): number {
  const vals = measureValues(records, fieldId)
  return vals.length === 0 ? 0 : vals.reduce((a, b) => (b < a ? b : a))
}

export function max(records: MetricRecord[], fieldId: string): number {
  const vals = measureValues(records, fieldId)
  return vals.length === 0 ? 0 : vals.reduce((a, b) => (b > a ? b : a))
}

export function groupBy(records: MetricRecord[], dimensionFieldId: string): Record<string, MetricRecord[]> {
  const out: Record<string, MetricRecord[]> = {}
  for (const r of records) {
    const key = r.mappedFields.dimensions[dimensionFieldId]?.value
    if (key === undefined) continue
    ;(out[key] ??= []).push(r)
  }
  return out
}

export type Granularity = 'day' | 'week' | 'month'

export function bucketByTime(records: MetricRecord[], granularity: Granularity): Record<string, MetricRecord[]> {
  const out: Record<string, MetricRecord[]> = {}
  for (const r of records) {
    if (!r.occurredAt) continue
    const key = timeKey(r.occurredAt, granularity)
    ;(out[key] ??= []).push(r)
  }
  return out
}

function timeKey(iso: string, granularity: Granularity): string {
  const d = new Date(iso)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  if (granularity === 'month') return `${y}-${m}`
  if (granularity === 'day') return `${y}-${m}-${String(d.getUTCDate()).padStart(2, '0')}`
  // week: ISO week start (Monday), keyed by that date
  const day = (d.getUTCDay() + 6) % 7
  const monday = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate() - day))
  return monday.toISOString().slice(0, 10)
}
