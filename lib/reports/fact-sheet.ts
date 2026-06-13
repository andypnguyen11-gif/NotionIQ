// lib/reports/fact-sheet.ts
import type { MetricRecord } from '@/lib/contracts/normalized'
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'
import type { Fact, FactSheet, MetricKind, MetricRequestSpec } from '@/lib/contracts/report'
import { count, sum, avg, min, max, groupBy } from '@/lib/metrics/primitives'

export interface FactSheetCaps {
  maxFacts: number
  maxGroups: number
  maxDimensionCardinality: number
}
export const DEFAULT_CAPS: FactSheetCaps = { maxFacts: 24, maxGroups: 8, maxDimensionCardinality: 20 }

// Deterministic, human-readable key: same request + version -> same id, independently of object
// key order. The verifier recomputes this id to line up with the AI's reference.
export function factId(req: MetricRequestSpec, snapshotVersion: number): string {
  return [snapshotVersion, req.sourceDatabaseId, req.metric, req.measureFieldId ?? '-', req.groupByDimensionId ?? '-', req.timeGranularity ?? '-'].join('::')
}

const METRIC_LABEL: Record<MetricKind, string> = { count: 'Count', sum: 'Sum', average: 'Average', min: 'Min', max: 'Max' }

function scalar(metric: MetricKind, recs: MetricRecord[], measureFieldId?: string): number | null {
  if (metric === 'count') return count(recs)
  if (!measureFieldId) return null
  const hasAny = recs.some((r) => typeof r.mappedFields.measures[measureFieldId]?.value === 'number')
  if (!hasAny) return null // empty/absent measure -> not renderable
  switch (metric) {
    case 'sum': return sum(recs, measureFieldId)
    case 'average': return avg(recs, measureFieldId)
    case 'min': return min(recs, measureFieldId)
    case 'max': return max(recs, measureFieldId)
    default: return null
  }
}

function deltaOf(value: number | null, previous: number | null): { previousValue?: number; delta?: { absolute: number; relative: number } } {
  if (value === null || previous === null) return {}
  const absolute = value - previous
  const relative = previous === 0 ? (absolute === 0 ? 0 : 1) : absolute / previous
  return { previousValue: previous, delta: { absolute, relative } }
}

// Single fact from records. Shared by buildFactSheet AND the verifier (genuine recompute, DRY).
export function computeFact(
  req: MetricRequestSpec,
  recs: { current: MetricRecord[]; previous: MetricRecord[] },
  snapshotVersion: number,
  computedAt: string,
  caps: FactSheetCaps = DEFAULT_CAPS,
): Fact {
  const base = { factId: factId(req, snapshotVersion), metricRequest: req, snapshotVersion, computedAt }
  if (req.groupByDimensionId) {
    const grouped = groupBy(recs.current, req.groupByDimensionId)
    const groups = Object.entries(grouped)
      .map(([key, rs]) => ({ key, value: scalar(req.metric, rs, req.measureFieldId) ?? 0 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, caps.maxGroups)
    const label = `${METRIC_LABEL[req.metric]} of ${req.measureFieldId ?? 'rows'} by ${req.groupByDimensionId}`
    return { ...base, label, value: null, groups }
  }
  const value = scalar(req.metric, recs.current, req.measureFieldId)
  const previous = recs.previous.length > 0 ? scalar(req.metric, recs.previous, req.measureFieldId) : null
  const label = `${METRIC_LABEL[req.metric]}${req.measureFieldId ? ` of ${req.measureFieldId}` : ''}`
  return { ...base, label, value, ...deltaOf(value, previous) }
}

export interface FactSheetDb {
  sourceDatabaseId: string
  mapping: DatabaseMappingProposal
  current: MetricRecord[]
  previous: MetricRecord[]
}

// Salience: facts with a larger relative delta first, then grouped facts (spread), then plain scalars.
function salience(f: Fact): number {
  if (f.delta) return 1000 + Math.abs(f.delta.relative)
  if (f.groups && f.groups.length > 1) return 500 + (f.groups[0].value - f.groups[f.groups.length - 1].value)
  return f.value === null ? 0 : 1
}

export function buildFactSheet(dbs: FactSheetDb[], snapshotVersion: number, generatedAt: string, caps: Partial<FactSheetCaps> = {}): FactSheet {
  const c: FactSheetCaps = { ...DEFAULT_CAPS, ...caps }
  const facts: Fact[] = []
  for (const db of dbs) {
    const measures = db.mapping.fields.filter((f) => f.role === 'measure').map((f) => f.notionPropertyId)
    const dimensions = db.mapping.fields.filter((f) => f.role === 'dimension').map((f) => f.notionPropertyId)
    const recs = { current: db.current, previous: db.previous }
    facts.push(computeFact({ metric: 'count', sourceDatabaseId: db.sourceDatabaseId }, recs, snapshotVersion, generatedAt, c))
    for (const m of measures) {
      for (const metric of ['sum', 'average', 'min', 'max'] as const) {
        facts.push(computeFact({ metric, sourceDatabaseId: db.sourceDatabaseId, measureFieldId: m }, recs, snapshotVersion, generatedAt, c))
      }
      for (const d of dimensions) {
        const cardinality = new Set(db.current.map((r) => r.mappedFields.dimensions[d]?.value).filter((v) => v !== undefined)).size
        if (cardinality === 0 || cardinality > c.maxDimensionCardinality) continue
        facts.push(computeFact({ metric: 'sum', sourceDatabaseId: db.sourceDatabaseId, measureFieldId: m, groupByDimensionId: d }, recs, snapshotVersion, generatedAt, c))
      }
    }
  }
  const ranked = facts.sort((a, b) => salience(b) - salience(a)).slice(0, c.maxFacts)
  return { snapshotVersion, generatedAt, facts: ranked }
}
