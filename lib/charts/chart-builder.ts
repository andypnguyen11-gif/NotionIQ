import type { DatabaseMappingProposal, Role } from '@/lib/contracts/mapping'
import type { NamedMetric } from '@/lib/contracts/metrics'
import { ChartConfigSchema, type ChartConfig } from '@/lib/contracts/chart'

export interface BuildChartRequest {
  shape: 'categorical' | 'timeseries' | 'kpi'
  metric: NamedMetric
  measureFieldId?: string
  groupByFieldId?: string // categorical
  bucket?: 'day' | 'week' | 'month' // timeseries
  topN?: number // categorical
  renderer?: 'bar' | 'pie' // categorical
}

export type BuildResult = { kind: 'chart'; config: ChartConfig } | { kind: 'unsupported'; reason: string }

const needsMeasure = (m: NamedMetric) => m === 'sum' || m === 'average' || m === 'revenue'

export function buildChart(mapping: DatabaseMappingProposal, req: BuildChartRequest): BuildResult {
  const roleOf = (id: string): Role | undefined => mapping.fields.find((f) => f.notionPropertyId === id)?.role

  if (needsMeasure(req.metric)) {
    if (!req.measureFieldId) return { kind: 'unsupported', reason: `${req.metric} requires a measure field` }
    if (roleOf(req.measureFieldId) !== 'measure')
      return { kind: 'unsupported', reason: 'measureFieldId is not a measure-role field' }
  }

  // Build the metric request with only the keys that apply, so the stored config is minimal and
  // stable. revenue bakes the mapping's classification in at build time (required on the proposal),
  // so aggregation never needs a DB round-trip for it.
  const metric = {
    metric: req.metric,
    ...(req.measureFieldId !== undefined ? { measureFieldId: req.measureFieldId } : {}),
    ...(req.metric === 'revenue' ? { classification: mapping.classification } : {}),
  }

  if (req.shape === 'kpi') return finalize({ shape: 'kpi', metric })

  if (req.shape === 'categorical') {
    if (!req.groupByFieldId) return { kind: 'unsupported', reason: 'categorical requires a groupByFieldId' }
    const role = roleOf(req.groupByFieldId)
    if (role !== 'dimension' && role !== 'status')
      return { kind: 'unsupported', reason: 'groupBy field must be a dimension or status role' }
    return finalize({
      shape: 'categorical',
      metric,
      groupByFieldId: req.groupByFieldId,
      groupByKind: role,
      ...(req.topN !== undefined ? { topN: req.topN } : {}),
      ...(req.renderer ? { renderer: req.renderer } : {}),
    })
  }

  // timeseries
  if (!mapping.occurredAtPropertyId) return { kind: 'unsupported', reason: 'timeseries requires an occurredAt mapping' }
  if (!req.bucket) return { kind: 'unsupported', reason: 'timeseries requires a bucket granularity' }
  return finalize({ shape: 'timeseries', metric, bucket: req.bucket })
}

// Parse through the schema so defaults (topN=20, renderer) and refinements are applied uniformly.
function finalize(raw: unknown): BuildResult {
  const parsed = ChartConfigSchema.safeParse(raw)
  if (!parsed.success) return { kind: 'unsupported', reason: parsed.error.issues[0]?.message ?? 'invalid chart config' }
  return { kind: 'chart', config: parsed.data }
}
