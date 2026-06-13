# chart-data-core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure analytical core + persistence for charts — a versioned `ChartDataContract`, a deterministic group-by/time-bucket aggregation engine over `NormalizedRecord`, a `chart-builder` that validates a request against an approved mapping, and tenant-scoped `Chart` persistence.

**Architecture:** All new aggregation is pure and delegates the actual number to the existing M3 metric engine (`resolveNamedMetric`) — code never invents numbers (D-7/ADR-4). Charts always read the workspace's **current** snapshot; a deterministic cache key (`chartId:workspaceId:filterSet:snapshotVersion`) auto-invalidates on the next scan. No HTTP routes, no React, no real Redis (cache is an injected interface) — those land in later M5 slices.

**Tech Stack:** TypeScript, zod (contracts), Prisma/Postgres (`Chart` model), Vitest (tests mock Prisma via `vi.fn()`). Reuses `lib/metrics/*` and `lib/contracts/{metrics,normalized,mapping}.ts`.

**Spec:** `docs/superpowers/specs/2026-06-13-chart-data-core-design.md`

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `lib/contracts/chart.ts` (create) | `ChartConfigSchema`, `ChartDataContractSchema`, `MetricRequestSchema`, `CHART_CONTRACT_VERSION` | 1 |
| `lib/data/normalized.ts` (modify) | add `getCurrentSnapshot` → `{ snapshotVersion, records }`; `getCurrentSnapshotRecords` delegates | 2 |
| `lib/charts/snapshot-query.ts` (create) | pure `aggregate`, pure `cacheKey`, cache-wrapped `queryChartData` (injected cache) | 3, 4 |
| `lib/charts/chart-builder.ts` (create) | `buildChart(mapping, req)` → validated `ChartConfig` or `unsupported` | 5 |
| `prisma/schema.prisma` (modify) + `prisma/migrations/0006_chart_init/migration.sql` (create) | `Chart` model + migration | 6 |
| `lib/data/charts.ts` (create) | tenant-scoped `createChart`/`getChart`/`listCharts` + shape-drift skip-warn | 7 |

Conventions to follow (from existing code): data-access functions take `prisma: PrismaClient` as the first argument; tests build a `fakePrisma()` with `vi.fn()` mocks (see `lib/data/snapshot-runs.test.ts`); contracts mirror the discriminated-union refusal pattern in `lib/contracts/metrics.ts`.

---

## Task 1: Chart contracts

**Files:**
- Create: `lib/contracts/chart.ts`
- Test: `lib/contracts/chart.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/contracts/chart.test.ts
import { describe, it, expect } from 'vitest'
import {
  ChartConfigSchema,
  ChartDataContractSchema,
  MetricRequestSchema,
  CHART_CONTRACT_VERSION,
} from './chart'

describe('MetricRequestSchema', () => {
  it('accepts count with no measure', () => {
    expect(MetricRequestSchema.safeParse({ metric: 'count' }).success).toBe(true)
  })
  it('rejects sum without a measureFieldId', () => {
    expect(MetricRequestSchema.safeParse({ metric: 'sum' }).success).toBe(false)
  })
  it('rejects revenue without a classification', () => {
    expect(MetricRequestSchema.safeParse({ metric: 'revenue', measureFieldId: 'm1' }).success).toBe(false)
  })
  it('accepts revenue with measure + classification', () => {
    expect(MetricRequestSchema.safeParse({ metric: 'revenue', measureFieldId: 'm1', classification: 'sales' }).success).toBe(true)
  })
})

describe('ChartConfigSchema', () => {
  it('defaults categorical topN to 20 and renderer to bar', () => {
    const parsed = ChartConfigSchema.parse({
      shape: 'categorical',
      metric: { metric: 'count' },
      groupByFieldId: 'd1',
      groupByKind: 'dimension',
    })
    expect(parsed).toMatchObject({ topN: 20, renderer: 'bar' })
  })
  it('rejects topN above 50', () => {
    const r = ChartConfigSchema.safeParse({
      shape: 'categorical', metric: { metric: 'count' }, groupByFieldId: 'd1', groupByKind: 'dimension', topN: 51,
    })
    expect(r.success).toBe(false)
  })
  it('requires groupByKind for categorical', () => {
    const r = ChartConfigSchema.safeParse({ shape: 'categorical', metric: { metric: 'count' }, groupByFieldId: 'd1' })
    expect(r.success).toBe(false)
  })
  it('accepts a timeseries config', () => {
    const r = ChartConfigSchema.safeParse({ shape: 'timeseries', metric: { metric: 'count' }, bucket: 'month' })
    expect(r.success).toBe(true)
  })
  it('accepts a kpi config', () => {
    expect(ChartConfigSchema.safeParse({ shape: 'kpi', metric: { metric: 'count' } }).success).toBe(true)
  })
})

describe('ChartDataContractSchema', () => {
  it('round-trips a categorical data contract', () => {
    const contract = {
      kind: 'data', version: CHART_CONTRACT_VERSION, snapshotVersion: 3, shape: 'categorical',
      points: [{ label: 'A', value: 5 }], truncated: false, omittedGroupCount: 0,
    }
    expect(ChartDataContractSchema.parse(contract)).toEqual(contract)
  })
  it('round-trips an unsupported contract', () => {
    const contract = { kind: 'unsupported', version: CHART_CONTRACT_VERSION, reason: 'average of an empty record set' }
    expect(ChartDataContractSchema.parse(contract)).toEqual(contract)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/contracts/chart.test.ts`
Expected: FAIL — cannot resolve module `./chart`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/contracts/chart.ts
import { z } from 'zod'
import { NamedMetricSchema } from './metrics'

export const CHART_CONTRACT_VERSION = 1 as const

// A resolved, validated metric request stored inside chart config. classification is baked in at
// build time (chart-builder), so aggregation never needs a DB round-trip for it.
export const MetricRequestSchema = z
  .object({
    metric: NamedMetricSchema,
    measureFieldId: z.string().min(1).optional(),
    classification: z.string().min(1).optional(),
  })
  .superRefine((req, ctx) => {
    if ((req.metric === 'sum' || req.metric === 'average' || req.metric === 'revenue') && !req.measureFieldId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${req.metric} requires a measureFieldId` })
    }
    if (req.metric === 'revenue' && !req.classification) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'revenue requires a classification' })
    }
  })
export type MetricRequest = z.infer<typeof MetricRequestSchema>

const CategoricalConfig = z.object({
  shape: z.literal('categorical'),
  metric: MetricRequestSchema,
  groupByFieldId: z.string().min(1),
  groupByKind: z.enum(['dimension', 'status']),
  topN: z.number().int().min(1).max(50).default(20),
  renderer: z.enum(['bar', 'pie']).default('bar'),
})
const TimeseriesConfig = z.object({
  shape: z.literal('timeseries'),
  metric: MetricRequestSchema,
  bucket: z.enum(['day', 'week', 'month']),
  renderer: z.literal('line').default('line'),
})
const KpiConfig = z.object({
  shape: z.literal('kpi'),
  metric: MetricRequestSchema,
})

export const ChartConfigSchema = z.discriminatedUnion('shape', [CategoricalConfig, TimeseriesConfig, KpiConfig])
export type ChartConfig = z.infer<typeof ChartConfigSchema>
export type ChartShape = ChartConfig['shape']

// --- versioned wire contract (ADR-6) ---
const Base = { version: z.literal(CHART_CONTRACT_VERSION), snapshotVersion: z.number().int() }

const UnsupportedContract = z.object({
  kind: z.literal('unsupported'),
  version: z.literal(CHART_CONTRACT_VERSION),
  reason: z.string().min(1),
})
const CategoricalData = z.object({
  kind: z.literal('data'), ...Base, shape: z.literal('categorical'),
  points: z.array(z.object({ label: z.string(), value: z.number() })),
  truncated: z.boolean(),
  omittedGroupCount: z.number().int(),
})
const TimeseriesData = z.object({
  kind: z.literal('data'), ...Base, shape: z.literal('timeseries'),
  granularity: z.enum(['day', 'week', 'month']),
  points: z.array(z.object({ bucket: z.string(), value: z.number() })),
})
const KpiData = z.object({
  kind: z.literal('data'), ...Base, shape: z.literal('kpi'),
  value: z.number(),
})

export const ChartDataContractSchema = z.union([UnsupportedContract, CategoricalData, TimeseriesData, KpiData])
export type ChartDataContract = z.infer<typeof ChartDataContractSchema>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/contracts/chart.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/contracts/chart.ts lib/contracts/chart.test.ts
git commit -m "feat(contracts): add versioned chart config and data contract"
```

---

## Task 2: `getCurrentSnapshot` helper (version + records)

**Files:**
- Modify: `lib/data/normalized.ts` (add `getCurrentSnapshot`; make `getCurrentSnapshotRecords` delegate)
- Test: `lib/data/normalized.test.ts` (add cases)

- [ ] **Step 1: Write the failing test** (append to the existing `describe` file)

```ts
// lib/data/normalized.test.ts — add these imports + cases
import { getCurrentSnapshot } from './normalized'
import type { PrismaClient } from '@prisma/client'
import { vi, it, expect } from 'vitest'

function fakePrismaSnap(version: number, rows: unknown[]) {
  return {
    workspace: { findUniqueOrThrow: vi.fn(async () => ({ snapshotVersion: version })) },
    normalizedRecord: { findMany: vi.fn(async () => rows) },
  } as unknown as PrismaClient
}

it('getCurrentSnapshot returns the workspace version alongside records', async () => {
  const prisma = fakePrismaSnap(7, [{ occurredAt: null, mappedFields: { measures: {}, dimensions: {}, status: {} } }])
  const res = await getCurrentSnapshot(prisma, { workspaceId: 'ws_1' })
  expect(res.snapshotVersion).toBe(7)
  expect(res.records).toHaveLength(1)
  expect(prisma.normalizedRecord.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ workspaceId: 'ws_1', snapshotVersion: 7 }) }),
  )
})

it('getCurrentSnapshot scopes to sourceDatabaseId when provided', async () => {
  const prisma = fakePrismaSnap(2, [])
  await getCurrentSnapshot(prisma, { workspaceId: 'ws_1', sourceDatabaseId: 'db_9' })
  expect(prisma.normalizedRecord.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ sourceDatabaseId: 'db_9' }) }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/data/normalized.test.ts`
Expected: FAIL — `getCurrentSnapshot` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `lib/data/normalized.ts`, replace the existing `getCurrentSnapshotRecords` function with:

```ts
// Reads the live snapshot AND the version that produced it, in one workspace-scoped path. The
// version is needed by both the cache key and the chart data contract. Always workspace-scoped (ADR-3).
export async function getCurrentSnapshot(
  prisma: PrismaClient,
  args: { workspaceId: string; sourceDatabaseId?: string },
): Promise<{ snapshotVersion: number; records: MetricRecord[] }> {
  const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: args.workspaceId }, select: { snapshotVersion: true } })
  const rows = await prisma.normalizedRecord.findMany({
    where: { workspaceId: args.workspaceId, snapshotVersion: ws.snapshotVersion, ...(args.sourceDatabaseId ? { sourceDatabaseId: args.sourceDatabaseId } : {}) },
  })
  return {
    snapshotVersion: ws.snapshotVersion,
    records: rows.map((r) => ({
      occurredAt: r.occurredAt ? r.occurredAt.toISOString() : null,
      mappedFields: MappedFieldsSchema.parse(r.mappedFields),
    })),
  }
}

// Back-compat for M4 callers: records only. Delegates to getCurrentSnapshot so behavior stays identical.
export async function getCurrentSnapshotRecords(
  prisma: PrismaClient,
  args: { workspaceId: string; sourceDatabaseId?: string },
): Promise<MetricRecord[]> {
  return (await getCurrentSnapshot(prisma, args)).records
}
```

- [ ] **Step 4: Run tests to verify they pass** (new cases AND the existing M4 reports tests that consume the records-only function)

Run: `npx vitest run lib/data/normalized.test.ts lib/reports`
Expected: PASS — new helper works and existing report tests still pass (delegation preserved behavior).

- [ ] **Step 5: Commit**

```bash
git add lib/data/normalized.ts lib/data/normalized.test.ts
git commit -m "feat(charts): read current snapshot version alongside records"
```

---

## Task 3: Aggregation engine (`aggregate`)

**Files:**
- Create: `lib/charts/snapshot-query.ts`
- Test: `lib/charts/snapshot-query.test.ts`

Notes: reuse `bucketByTime` from `lib/metrics/primitives.ts` (UTC day/week/month, skips null `occurredAt`). The M3 engine request type uses `measureFieldIds: string[]`, so bridge the singular `measureFieldId` → `[id]`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/charts/snapshot-query.test.ts
import { describe, it, expect } from 'vitest'
import { aggregate } from './snapshot-query'
import type { MetricRecord } from '@/lib/contracts/normalized'
import type { ChartConfig } from '@/lib/contracts/chart'

const rec = (dim: string | undefined, occurredAt: string | null = null, measure?: number): MetricRecord => ({
  occurredAt,
  mappedFields: {
    measures: measure === undefined ? {} : { m1: { name: 'amt', value: measure } },
    dimensions: dim === undefined ? {} : { d1: { name: 'region', value: dim } },
    status: {},
  },
})

describe('aggregate — categorical', () => {
  const config: ChartConfig = { shape: 'categorical', metric: { metric: 'count' }, groupByFieldId: 'd1', groupByKind: 'dimension', topN: 20, renderer: 'bar' }

  it('counts per group, sorted value desc then label asc', () => {
    const recs = [rec('B'), rec('A'), rec('A'), rec('C'), rec('C')]
    const out = aggregate(recs, config, 4)
    expect(out).toEqual({
      kind: 'data', version: 1, snapshotVersion: 4, shape: 'categorical',
      points: [{ label: 'A', value: 2 }, { label: 'C', value: 2 }, { label: 'B', value: 1 }],
      truncated: false, omittedGroupCount: 0,
    })
  })

  it('labels missing/null group values "(Unspecified)"', () => {
    const out = aggregate([rec(undefined), rec(undefined), rec('A')], config, 1)
    expect(out).toMatchObject({ kind: 'data', points: [{ label: '(Unspecified)', value: 2 }, { label: 'A', value: 1 }] })
  })

  it('truncates to topN with an omitted count', () => {
    const recs = ['A', 'B', 'C', 'D'].flatMap((d, i) => Array.from({ length: 4 - i }, () => rec(d)))
    const out = aggregate(recs, { ...config, topN: 2 }, 1)
    expect(out).toMatchObject({ truncated: true, omittedGroupCount: 2, points: [{ label: 'A', value: 4 }, { label: 'B', value: 3 }] })
  })

  it('returns empty data (not a refusal) for an empty snapshot', () => {
    expect(aggregate([], config, 9)).toEqual({
      kind: 'data', version: 1, snapshotVersion: 9, shape: 'categorical', points: [], truncated: false, omittedGroupCount: 0,
    })
  })
})

describe('aggregate — timeseries', () => {
  const config: ChartConfig = { shape: 'timeseries', metric: { metric: 'count' }, bucket: 'month', renderer: 'line' }

  it('buckets by UTC month, non-empty only, sorted asc; skips null occurredAt', () => {
    const recs = [rec('x', '2026-02-10T00:00:00.000Z'), rec('x', '2026-01-05T00:00:00.000Z'), rec('x', '2026-01-20T00:00:00.000Z'), rec('x', null)]
    const out = aggregate(recs, config, 2)
    expect(out).toEqual({
      kind: 'data', version: 1, snapshotVersion: 2, shape: 'timeseries', granularity: 'month',
      points: [{ bucket: '2026-01', value: 2 }, { bucket: '2026-02', value: 1 }],
    })
  })

  it('returns empty data when every record has null occurredAt', () => {
    expect(aggregate([rec('x', null)], config, 1)).toMatchObject({ kind: 'data', shape: 'timeseries', points: [] })
  })
})

describe('aggregate — kpi', () => {
  it('returns a scalar value for count', () => {
    expect(aggregate([rec('a'), rec('b')], { shape: 'kpi', metric: { metric: 'count' } }, 5)).toEqual({
      kind: 'data', version: 1, snapshotVersion: 5, shape: 'kpi', value: 2,
    })
  })
  it('passes through the engine refusal for average over zero records', () => {
    const out = aggregate([], { shape: 'kpi', metric: { metric: 'average', measureFieldId: 'm1' } }, 5)
    expect(out).toMatchObject({ kind: 'unsupported', version: 1 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/charts/snapshot-query.test.ts`
Expected: FAIL — cannot resolve `./snapshot-query`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/charts/snapshot-query.ts
import type { MetricRecord } from '@/lib/contracts/normalized'
import type { NamedMetricRequest } from '@/lib/contracts/metrics'
import { resolveNamedMetric } from '@/lib/metrics/named'
import { bucketByTime } from '@/lib/metrics/primitives'
import { CHART_CONTRACT_VERSION, type ChartConfig, type ChartDataContract, type MetricRequest } from '@/lib/contracts/chart'

const UNSPECIFIED = '(Unspecified)'

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
      const label = rec.mappedFields[config.groupByKind][config.groupByFieldId]?.value ?? UNSPECIFIED
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
    points.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/charts/snapshot-query.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/charts/snapshot-query.ts lib/charts/snapshot-query.test.ts
git commit -m "feat(charts): add deterministic chart aggregation engine"
```

---

## Task 4: Cache key + cache-wrapped query

**Files:**
- Modify: `lib/charts/snapshot-query.ts` (add `cacheKey`, `ChartCache`, `ChartForQuery`, `queryChartData`)
- Test: `lib/charts/snapshot-query.test.ts` (add cases)

- [ ] **Step 1: Write the failing test** (append)

```ts
// lib/charts/snapshot-query.test.ts — add
import { cacheKey, queryChartData, type ChartCache, type ChartForQuery } from './snapshot-query'
import type { PrismaClient } from '@prisma/client'
import { vi } from 'vitest'

describe('cacheKey', () => {
  it('is deterministic and version-sensitive', () => {
    const base = { chartId: 'c1', workspaceId: 'w1', normalizedFilterSet: '' }
    expect(cacheKey({ ...base, snapshotVersion: 3 })).toBe('c1:w1::3')
    expect(cacheKey({ ...base, snapshotVersion: 4 })).not.toBe(cacheKey({ ...base, snapshotVersion: 3 }))
  })
})

describe('queryChartData', () => {
  const chart: ChartForQuery = {
    id: 'c1', workspaceId: 'w1', sourceDatabaseId: 'db1',
    config: { shape: 'kpi', metric: { metric: 'count' } },
  }
  function deps(version: number, rows: unknown[], cacheValue: string | null) {
    const cache: ChartCache = { get: vi.fn(async () => cacheValue), set: vi.fn(async () => {}) }
    const prisma = {
      workspace: { findUniqueOrThrow: vi.fn(async () => ({ snapshotVersion: version })) },
      normalizedRecord: { findMany: vi.fn(async () => rows) },
    } as unknown as PrismaClient
    return { prisma, cache }
  }

  it('on cache miss: aggregates and writes the result under the versioned key', async () => {
    const d = deps(2, [{ occurredAt: null, mappedFields: { measures: {}, dimensions: {}, status: {} } }], null)
    const out = await queryChartData(d, chart)
    expect(out).toMatchObject({ kind: 'data', shape: 'kpi', value: 1, snapshotVersion: 2 })
    expect(d.cache.set).toHaveBeenCalledWith('c1:w1::2', JSON.stringify(out))
  })

  it('on cache hit: returns the cached contract without re-aggregating', async () => {
    const cached = { kind: 'data', version: 1, snapshotVersion: 2, shape: 'kpi', value: 99 }
    const d = deps(2, [], JSON.stringify(cached))
    const out = await queryChartData(d, chart)
    expect(out).toEqual(cached)
    expect(d.cache.set).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/charts/snapshot-query.test.ts`
Expected: FAIL — `cacheKey` / `queryChartData` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `lib/charts/snapshot-query.ts`)

```ts
import type { PrismaClient } from '@prisma/client'
import { getCurrentSnapshot } from '@/lib/data/normalized'
import { ChartDataContractSchema } from '@/lib/contracts/chart'

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
// contract's snapshotVersion always agree even if a scan commits mid-request.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/charts/snapshot-query.test.ts`
Expected: PASS (all cases, including Task 3's).

- [ ] **Step 5: Commit**

```bash
git add lib/charts/snapshot-query.ts lib/charts/snapshot-query.test.ts
git commit -m "feat(charts): add deterministic cache key and cache-wrapped chart query"
```

---

## Task 5: `chart-builder` (validate request against mapping)

**Files:**
- Create: `lib/charts/chart-builder.ts`
- Test: `lib/charts/chart-builder.test.ts`

Notes: validates field roles against an approved `DatabaseMappingProposal` (`lib/contracts/mapping.ts`), resolves `groupByKind`, bakes `classification` for revenue, and applies defaults by parsing through `ChartConfigSchema`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/charts/chart-builder.test.ts
import { describe, it, expect } from 'vitest'
import { buildChart } from './chart-builder'
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'

const field = (id: string, role: string) => ({
  notionPropertyId: id, name: id, notionType: 'x', candidateRole: role, role, confidence: 1, rationale: 'r',
})
const mapping = (occurredAt: string | null = 'p_date'): DatabaseMappingProposal => ({
  classification: 'sales',
  occurredAtPropertyId: occurredAt,
  fields: [field('p_region', 'dimension'), field('p_stage', 'status'), field('p_amt', 'measure')],
  modelVersion: 'm', promptVersion: 'p',
}) as DatabaseMappingProposal

describe('buildChart', () => {
  it('builds a categorical config and resolves groupByKind=dimension', () => {
    const r = buildChart(mapping(), { shape: 'categorical', metric: 'count', groupByFieldId: 'p_region' })
    expect(r).toEqual({ kind: 'chart', config: { shape: 'categorical', metric: { metric: 'count' }, groupByFieldId: 'p_region', groupByKind: 'dimension', topN: 20, renderer: 'bar' } })
  })

  it('resolves groupByKind=status for a status field', () => {
    const r = buildChart(mapping(), { shape: 'categorical', metric: 'count', groupByFieldId: 'p_stage' })
    expect(r).toMatchObject({ kind: 'chart', config: { groupByKind: 'status' } })
  })

  it('refuses categorical when the groupBy field is a measure (wrong role)', () => {
    const r = buildChart(mapping(), { shape: 'categorical', metric: 'count', groupByFieldId: 'p_amt' })
    expect(r).toMatchObject({ kind: 'unsupported' })
  })

  it('refuses sum without a measure field', () => {
    expect(buildChart(mapping(), { shape: 'kpi', metric: 'sum' })).toMatchObject({ kind: 'unsupported' })
  })

  it('refuses sum when the measure field is not measure-role', () => {
    expect(buildChart(mapping(), { shape: 'kpi', metric: 'sum', measureFieldId: 'p_region' })).toMatchObject({ kind: 'unsupported' })
  })

  it('bakes classification into the metric for revenue', () => {
    const r = buildChart(mapping(), { shape: 'kpi', metric: 'revenue', measureFieldId: 'p_amt' })
    expect(r).toMatchObject({ kind: 'chart', config: { metric: { metric: 'revenue', measureFieldId: 'p_amt', classification: 'sales' } } })
  })

  it('refuses timeseries when the mapping has no occurredAt', () => {
    expect(buildChart(mapping(null), { shape: 'timeseries', metric: 'count', bucket: 'month' })).toMatchObject({ kind: 'unsupported' })
  })

  it('builds a timeseries config when occurredAt is mapped', () => {
    expect(buildChart(mapping(), { shape: 'timeseries', metric: 'count', bucket: 'week' })).toMatchObject({ kind: 'chart', config: { shape: 'timeseries', bucket: 'week', renderer: 'line' } })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/charts/chart-builder.test.ts`
Expected: FAIL — cannot resolve `./chart-builder`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/charts/chart-builder.ts
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
    if (roleOf(req.measureFieldId) !== 'measure') return { kind: 'unsupported', reason: 'measureFieldId is not a measure-role field' }
  }
  // revenue classification is always present: DatabaseMappingProposal.classification is required.
  const classification = req.metric === 'revenue' ? mapping.classification : undefined
  const metric = { metric: req.metric, measureFieldId: req.measureFieldId, classification }

  if (req.shape === 'kpi') return finalize({ shape: 'kpi', metric })

  if (req.shape === 'categorical') {
    if (!req.groupByFieldId) return { kind: 'unsupported', reason: 'categorical requires a groupByFieldId' }
    const role = roleOf(req.groupByFieldId)
    if (role !== 'dimension' && role !== 'status') return { kind: 'unsupported', reason: 'groupBy field must be a dimension or status role' }
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/charts/chart-builder.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/charts/chart-builder.ts lib/charts/chart-builder.test.ts
git commit -m "feat(charts): add chart-builder validating requests against a mapping"
```

---

## Task 6: `Chart` Prisma model + migration

**Files:**
- Modify: `prisma/schema.prisma` (add `Chart` model; add `charts Chart[]` to `Workspace`)
- Create: `prisma/migrations/0006_chart_init/migration.sql`

- [ ] **Step 1: Add the model to `prisma/schema.prisma`**

Add the relation field to the `Workspace` model's relation block (after `reportClaims ReportClaim[]`):

```prisma
  charts            Chart[]
```

Append the new model (after the last model in the file):

```prisma
model Chart {
  id                      String   @id @default(cuid())
  workspaceId             String // tenant scope (ADR-3) — always in WHERE
  sourceDatabaseId        String // the notionDatabaseId this chart reads
  shape                   String // categorical | timeseries | kpi — for cheap listing/index
  config                  Json // validated by ChartConfigSchema; config.shape must equal shape
  title                   String
  snapshotVersionAtCreate Int // provenance only — never a query filter
  createdAt               DateTime @default(now())
  updatedAt               DateTime @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId])
}
```

- [ ] **Step 2: Create the migration SQL**

```sql
-- prisma/migrations/0006_chart_init/migration.sql
-- CreateTable
CREATE TABLE "Chart" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceDatabaseId" TEXT NOT NULL,
    "shape" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "title" TEXT NOT NULL,
    "snapshotVersionAtCreate" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Chart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Chart_workspaceId_idx" ON "Chart"("workspaceId");

-- AddForeignKey
ALTER TABLE "Chart" ADD CONSTRAINT "Chart_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Regenerate the Prisma client** (so `prisma.chart` and its types exist for typecheck/tests)

Run: `npx prisma generate`
Expected: "Generated Prisma Client" with no schema errors.

- [ ] **Step 4: Verify schema + client compile**

Run: `npx prisma validate && npm run typecheck`
Expected: schema valid; typecheck passes (no usages yet, just the new model type).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/0006_chart_init/migration.sql
git commit -m "feat(charts): add chart prisma model and migration"
```

---

## Task 7: Tenant-scoped chart data access

**Files:**
- Create: `lib/data/charts.ts`
- Test: `lib/data/charts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/data/charts.test.ts
import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { createChart, getChart, listCharts } from './charts'
import type { ChartConfig } from '@/lib/contracts/chart'

const config: ChartConfig = { shape: 'kpi', metric: { metric: 'count' } }
const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1', workspaceId: 'w1', sourceDatabaseId: 'db1', shape: 'kpi', config, title: 'T', snapshotVersionAtCreate: 3, ...over,
})

function fakePrisma(over: Record<string, unknown> = {}) {
  return {
    chart: {
      create: vi.fn(async () => ({ id: 'c1' })),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      ...over,
    },
  } as unknown as PrismaClient
}

describe('createChart', () => {
  it('writes config.shape into the shape column (drift guard) scoped to the workspace', async () => {
    const prisma = fakePrisma()
    const res = await createChart(prisma, { workspaceId: 'w1', sourceDatabaseId: 'db1', config, title: 'T', snapshotVersionAtCreate: 3 })
    expect(res).toEqual({ id: 'c1' })
    expect(prisma.chart.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ workspaceId: 'w1', shape: 'kpi', title: 'T', snapshotVersionAtCreate: 3 }),
    }))
  })
})

describe('getChart', () => {
  it('scopes the lookup by workspaceId AND chartId (ADR-3)', async () => {
    const prisma = fakePrisma({ findFirst: vi.fn(async () => row()) })
    const res = await getChart(prisma, { workspaceId: 'w1', chartId: 'c1' })
    expect(res).toMatchObject({ id: 'c1', config })
    expect(prisma.chart.findFirst).toHaveBeenCalledWith({ where: { id: 'c1', workspaceId: 'w1' } })
  })
  it('returns null for a row whose stored shape disagrees with config.shape', async () => {
    const prisma = fakePrisma({ findFirst: vi.fn(async () => row({ shape: 'categorical' })) })
    expect(await getChart(prisma, { workspaceId: 'w1', chartId: 'c1' })).toBeNull()
  })
})

describe('listCharts', () => {
  it('skips a corrupt-config row instead of throwing', async () => {
    const prisma = fakePrisma({ findMany: vi.fn(async () => [row(), row({ id: 'bad', config: { shape: 'kpi' } /* missing metric */ })]) })
    const res = await listCharts(prisma, { workspaceId: 'w1' })
    expect(res).toHaveLength(1)
    expect(res[0].id).toBe('c1')
    expect(prisma.chart.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: 'w1' } }))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/data/charts.test.ts`
Expected: FAIL — cannot resolve `./charts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/data/charts.ts
import type { PrismaClient, Prisma } from '@prisma/client'
import { ChartConfigSchema, type ChartConfig } from '@/lib/contracts/chart'
import { log } from '@/lib/log'

export interface ChartRecord {
  id: string
  workspaceId: string
  sourceDatabaseId: string
  config: ChartConfig
  title: string
  snapshotVersionAtCreate: number
}

// Always writes config.shape into the shape column so the two can never drift on insert.
export async function createChart(
  prisma: PrismaClient,
  args: { workspaceId: string; sourceDatabaseId: string; config: ChartConfig; title: string; snapshotVersionAtCreate: number },
): Promise<{ id: string }> {
  const created = await prisma.chart.create({
    data: {
      workspaceId: args.workspaceId,
      sourceDatabaseId: args.sourceDatabaseId,
      shape: args.config.shape,
      config: args.config as unknown as Prisma.InputJsonValue,
      title: args.title,
      snapshotVersionAtCreate: args.snapshotVersionAtCreate,
    },
  })
  return { id: created.id }
}

// Tenant-scoped (ADR-3): workspaceId is always in the WHERE.
export async function getChart(prisma: PrismaClient, args: { workspaceId: string; chartId: string }): Promise<ChartRecord | null> {
  const found = await prisma.chart.findFirst({ where: { id: args.chartId, workspaceId: args.workspaceId } })
  return found ? parseRow(found) : null
}

export async function listCharts(prisma: PrismaClient, args: { workspaceId: string }): Promise<ChartRecord[]> {
  const rows = await prisma.chart.findMany({ where: { workspaceId: args.workspaceId }, orderBy: { createdAt: 'asc' } })
  const out: ChartRecord[] = []
  for (const r of rows) {
    const parsed = parseRow(r)
    if (parsed) out.push(parsed)
  }
  return out
}

// safeParse + shape-drift guard: one bad row never blanks the list or throws (M3/M7 ethos).
function parseRow(row: { id: string; workspaceId: string; sourceDatabaseId: string; shape: string; config: unknown; title: string; snapshotVersionAtCreate: number }): ChartRecord | null {
  const parsed = ChartConfigSchema.safeParse(row.config)
  if (!parsed.success || parsed.data.shape !== row.shape) {
    log.warn('chart_config_skipped', { chartId: row.id, workspaceId: row.workspaceId, reason: parsed.success ? 'shape_mismatch' : 'invalid_config' })
    return null
  }
  return {
    id: row.id, workspaceId: row.workspaceId, sourceDatabaseId: row.sourceDatabaseId,
    config: parsed.data, title: row.title, snapshotVersionAtCreate: row.snapshotVersionAtCreate,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/data/charts.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/data/charts.ts lib/data/charts.test.ts
git commit -m "feat(charts): add tenant-scoped chart data access"
```

---

## Final verification

- [ ] **Run the full gate** (per AGENTS.md, all must pass before a PR):

Run: `npm run typecheck && npm run lint && npm run test && npm run build`
Expected: all green.

- [ ] **Confirm the slice boundary holds:** no HTTP route, no React, no `ioredis` import in `lib/charts/` (cache is the injected `ChartCache` interface), `groupBy` in `lib/metrics/primitives.ts` unchanged.

---

## Spec coverage map (self-review)

| Spec requirement | Task |
| --- | --- |
| `ChartConfigSchema` (3 shapes, groupByKind, topN 1..50 default 20, renderer) | 1 |
| `MetricRequestSchema` with revenue⇒classification, measure refinements | 1 |
| Versioned `ChartDataContractSchema` + `CHART_CONTRACT_VERSION` | 1 |
| `getCurrentSnapshot` → `{ snapshotVersion, records }`; back-compat delegate | 2 |
| Categorical: value-desc/label-asc, top-N truncate-with-flag, "(Unspecified)" | 3 |
| Timeseries: UTC day/week/month (reuse `bucketByTime`), non-empty-only asc, null-occurredAt skipped | 3 |
| KPI: reuse `resolveNamedMetric` | 3 |
| Empty-snapshot behavior by shape (categorical/timeseries empty data; kpi delegates) | 3 |
| Two unsupported channels: runtime pass-through in `aggregate` | 3 |
| Deterministic `cacheKey` (ADR-4), filterSet `''` placeholder | 4 |
| `queryChartData` snapshot-first ordering, injected cache, hit/miss | 4 |
| `chart-builder` validation, groupByKind resolution, classification baking, build-time refusals | 5 |
| `Chart` model + migration (provenance `snapshotVersionAtCreate`, `@@index([workspaceId])`) | 6 |
| Tenant-scoped data access + shape-drift guard + skip-warn | 7 |
| Engine never invents numbers (delegates to metric engine) | 3, 5 |
