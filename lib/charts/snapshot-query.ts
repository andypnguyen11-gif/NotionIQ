import type { PrismaClient } from '@prisma/client'
import type { MetricRecord } from '@/lib/contracts/normalized'
import type { NamedMetricRequest } from '@/lib/contracts/metrics'
import { resolveNamedMetric } from '@/lib/metrics/named'
import { bucketByTime } from '@/lib/metrics/primitives'
import { getCurrentSnapshot } from '@/lib/data/normalized'
import { CHART_CONTRACT_VERSION, ChartDataContractSchema, type ChartConfig, type ChartDataContract, type MetricRequest } from '@/lib/contracts/chart'

const UNSPECIFIED = '(Unspecified)'

// groupByKind uses the singular contract enum ('dimension' | 'status'); the persisted mappedFields
// buckets are keyed plurally ('dimensions' | 'status'). Map between them.
const BUCKET_KEY = { dimension: 'dimensions', status: 'status' } as const

// Bridge the contract's singular measureFieldId to the engine's measureFieldIds[] shape.
function toEngineRequest(m: MetricRequest): NamedMetricRequest {
  return { metric: m.metric, measureFieldIds: m.measureFieldId ? [m.measureFieldId] : [], classification: m.classification }
}

// Pure, deterministic. Groups records then delegates the number to resolveNamedMetric — never computes
// a number itself (D-7). snapshotVersion is embedded into the contract by the caller's read.
export function aggregate(records: MetricRecord[], config: ChartConfig, snapshotVersion: number): ChartDataContract {
  const req = toEngineRequest(config.metric)

  if (config.shape === 'kpi') {
    const r = resolveNamedMetric(records, req)
    return r.kind === 'value'
      ? { kind: 'data', version: CHART_CONTRACT_VERSION, snapshotVersion, shape: 'kpi', value: r.value }
      : { kind: 'unsupported', version: CHART_CONTRACT_VERSION, reason: r.reason }
  }

  if (config.shape === 'categorical') {
    const groups = new Map<string, MetricRecord[]>()
    for (const rec of records) {
      const label = rec.mappedFields[BUCKET_KEY[config.groupByKind]][config.groupByFieldId]?.value ?? UNSPECIFIED
      const arr = groups.get(label)
      if (arr) arr.push(rec)
      else groups.set(label, [rec])
    }
    const points: { label: string; value: number }[] = []
    for (const [label, recs] of groups) {
      const r = resolveNamedMetric(recs, req)
      if (r.kind !== 'value') return { kind: 'unsupported', version: CHART_CONTRACT_VERSION, reason: r.reason }
      points.push({ label, value: r.value })
    }
    // Code-point comparison (not localeCompare): deterministic, locale-independent ordering so the
    // tiebreak — and the downstream cache key — stay stable across dev/prod and ICU versions.
    points.sort((a, b) => b.value - a.value || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    const kept = points.slice(0, config.topN)
    const omittedGroupCount = points.length - kept.length
    return {
      kind: 'data', version: CHART_CONTRACT_VERSION, snapshotVersion, shape: 'categorical',
      points: kept, truncated: omittedGroupCount > 0, omittedGroupCount,
    }
  }

  // timeseries
  const buckets = bucketByTime(records, config.bucket)
  const points: { bucket: string; value: number }[] = []
  for (const bucket of Object.keys(buckets).sort()) {
    const r = resolveNamedMetric(buckets[bucket], req)
    if (r.kind !== 'value') return { kind: 'unsupported', version: CHART_CONTRACT_VERSION, reason: r.reason }
    points.push({ bucket, value: r.value })
  }
  return { kind: 'data', version: CHART_CONTRACT_VERSION, snapshotVersion, shape: 'timeseries', granularity: config.bucket, points }
}

// Deterministic aggregation cache key (ADR-4). normalizedFilterSet is '' in this slice; the
// config-filters slice fills it in with the same normalization so keys stay stable across slices.
export function cacheKey(args: { chartId: string; workspaceId: string; normalizedFilterSet: string; snapshotVersion: number }): string {
  return `${args.chartId}:${args.workspaceId}:${args.normalizedFilterSet}:${args.snapshotVersion}`
}

export interface ChartCache {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

export interface ChartForQuery {
  id: string
  workspaceId: string
  sourceDatabaseId: string
  config: ChartConfig
}

// Order matters: read the snapshot FIRST (it yields the version the key needs), so the key and the
// contract's snapshotVersion always agree even if a scan commits mid-request. On hit, re-validate
// the cached JSON through the contract schema before returning.
export async function queryChartData(
  deps: { prisma: PrismaClient; cache: ChartCache },
  chart: ChartForQuery,
): Promise<ChartDataContract> {
  const { snapshotVersion, records } = await getCurrentSnapshot(deps.prisma, {
    workspaceId: chart.workspaceId,
    sourceDatabaseId: chart.sourceDatabaseId,
  })
  const key = cacheKey({ chartId: chart.id, workspaceId: chart.workspaceId, normalizedFilterSet: '', snapshotVersion })
  const cached = await deps.cache.get(key)
  if (cached) return ChartDataContractSchema.parse(JSON.parse(cached))
  const contract = aggregate(records, chart.config, snapshotVersion)
  await deps.cache.set(key, JSON.stringify(contract))
  return contract
}
