# chart-data-core — Design Spec

> **Part of M5 (Charts), decomposed.** M5 is split into three feature-named sub-projects, each its
> own spec → plan → branch:
>
> - **`chart-data-core`** (this spec) — `Chart` model, versioned `ChartDataContract`, the
>   group-by/time-bucket aggregation engine, `chart-builder`, tenant-scoped data access, deterministic
>   cache key.
> - **`chart-embed-delivery`** — `EmbedToken` model, durable-token exchange → short-lived JWT, embed
>   route/page, data API, CSP/security tests.
> - **`chart-config-filters`** — `ChartFilter` model, `filter-engine` suggestions + cardinality guard,
>   in-app management UI, report-writer embed-block insertion.
>
> Data models are split by ownership: `Chart` here, `EmbedToken` in embed-delivery, `ChartFilter` in
> config-filters. Each migration lands with the slice that owns it.
>
> **Source spec:** `docs/superpowers/specs/2026-06-05-notioniq-mvp-design.md` (ADR-1, ADR-3, ADR-4,
> ADR-6; §4 Charts subsystem; §5 data model).

## 1. Summary

The pure analytical core and persistence for charts. It turns an approved `DatabaseMapping` + a metric
request into a validated, persisted `Chart` definition, and aggregates the workspace's **current
snapshot** of `NormalizedRecord`s into a versioned, deterministic `ChartDataContract` — the only wire
format the embed/data API (next slice) will serve.

The genuinely new analytical work is a **deterministic group-by / time-bucket layer**. The M3 metric
engine (`resolveNamedMetric`) only returns a single scalar; charts need *series* ("count by status",
"revenue over time"). This slice adds grouping **on top of** the existing metric primitives — the
engine groups records and then calls `resolveNamedMetric` per group, so the rule that **AI/code never
invents numbers, the metric engine is the source of truth** (spec D-7 / ADR-4) is preserved.

### In scope

`Chart` Prisma model + migration; `ChartConfigSchema` + versioned `ChartDataContractSchema`; the
aggregation engine (`snapshot-query`); `chart-builder` (validate a request against a mapping);
tenant-scoped data access (`lib/data/charts.ts`); a `getCurrentSnapshot` helper that returns the
snapshot version alongside records; a deterministic cache key + cache-wrapped query with an **injected**
cache interface; focused TDD coverage.

### Out of scope (owned by later M5 slices)

`EmbedToken` / embed auth / embed route / HTTP data API (embed-delivery). `ChartFilter` / filter-engine
/ in-app management UI / report-writer embed-block insertion (config-filters). No HTTP route handlers,
no React components, no real Redis wiring (only an injectable cache interface). No multi-series,
stacked/grouped, dual-axis, scatter, or custom chart composition (out of MVP entirely).

## 2. Supported chart shapes (MVP)

Three data **shapes**, fixed here. Renderer choice is a presentation flag carried on the config — **not**
a different computation.

| Shape         | Produces                                  | Default renderer | Notes                                   |
| ------------- | ----------------------------------------- | ---------------- | --------------------------------------- |
| `categorical` | a metric grouped by one dimension/status  | `bar` (or `pie`) | top-N with truncation flag              |
| `timeseries`  | a metric bucketed by `occurredAt`         | `line`           | UTC buckets; day / week / month only    |
| `kpi`         | a single scalar (reuses metric engine)    | n/a              | exactly today's `resolveNamedMetric`    |

## 3. Deterministic rules (the heart of the spec)

These are locked and must be enforced by tests.

- **Ordering**
  - categorical → **value desc, ties broken by label asc** (stable).
  - timeseries → **bucket asc**.
  - kpi → no series, no ordering.
- **Categorical top-N** → **truncate-with-flag**. Keep the top `topN` groups; set `truncated: boolean`
  and `omittedGroupCount: number`. **No "Other" rollup** — folding a tail is mathematically wrong for
  `average` and invites misreading for count/sum. `topN` is bounded **int, min 1, max 50**;
  `chart-builder` defaults it to **20**.
- **Null / missing category value** → deterministic label **`"(Unspecified)"`**. It is a real group of
  real records and participates exactly like any other group: it sorts by value-desc/label-asc and **may
  be omitted if it falls outside top-N**, in which case it is included in `omittedGroupCount`. It gets no
  special pinning.
- **Time buckets** → **UTC only**. `day` = UTC calendar day; `week` = ISO week (Monday start), keyed by
  the UTC date of that Monday; `month` = UTC calendar month. This deliberately sidesteps the M7
  locale-parsing follow-up.
- **Empty time buckets** → **emit only non-empty buckets** (sorted asc). No zero-fill: a gap means "no
  data," which is *not* the same as `0`, and zero-fill is wrong for `average`. (A future opt-in zero-fill
  for count/sum can be an explicit renderer/contract option — not now.)
- **Honest refusal** → any "cannot truthfully produce this" path returns `kind: 'unsupported'` with a
  reason; never a fabricated or silently-zero value. Mirrors `MetricResultSchema`.

## 4. Module layout

- `lib/contracts/chart.ts` — `ChartConfigSchema` (definition/input) + `ChartDataContractSchema`
  (versioned output) + `CHART_CONTRACT_VERSION`.
  - **Deliberate deviation from the source spec's module map**, which named `lib/charts/contract.ts`.
    The repo's stronger, repeatedly-stated convention (AGENTS.md + roadmap cross-cutting conventions +
    every existing contract in `lib/contracts/`) is that shared zod contracts live in `lib/contracts/`
    and are imported by both API and embed. We follow the convention; engine logic stays in
    `lib/charts/`.
- `lib/charts/snapshot-query.ts` — pure `aggregate(records, config)`; pure `cacheKey(...)`; a thin
  cache-wrapped `queryChartData(deps, args)` whose cache is an **injected interface** (real Redis is
  wired in embed-delivery, where charts are actually served).
- `lib/charts/chart-builder.ts` — pure `buildChart(mapping, request)` → a validated `ChartConfig` **or**
  an `unsupported` refusal.
- `lib/data/charts.ts` — tenant-scoped `createChart` / `getChart` / `listCharts` (every query carries
  `workspaceId` in the WHERE — ADR-3).
- `lib/data/normalized.ts` — **add** `getCurrentSnapshot(prisma, { workspaceId, sourceDatabaseId? })`
  returning `{ snapshotVersion, records }`. Existing `getCurrentSnapshotRecords` delegates to it (kept
  for M4 callers), so the version that produced the records is available to both the cache key and the
  contract in a single query path.

## 5. Data model — `Chart` (migration `0006_chart_init`)

| Column                    | Type      | Notes                                                              |
| ------------------------- | --------- | ----------------------------------------------------------------- |
| `id`                      | cuid PK   |                                                                   |
| `workspaceId`             | String    | tenant scope (ADR-3) — always in WHERE; `onDelete: Cascade`       |
| `sourceDatabaseId`        | String    | the `notionDatabaseId` the chart reads                            |
| `shape`                   | String    | `categorical | timeseries | kpi` — for cheap listing/index        |
| `config`                  | Json      | validated by `ChartConfigSchema`                                   |
| `title`                   | String    |                                                                   |
| `snapshotVersionAtCreate` | Int       | **provenance only** — never a query filter                        |
| `createdAt` / `updatedAt` | DateTime  |                                                                   |

Index `@@index([workspaceId])`.

- **Shape drift guard:** `createChart` validates `shape === config.shape` before writing. Reads
  `safeParse` the config and **skip-warn** a row whose stored `shape` ≠ `config.shape` or whose config
  is invalid (M3/M7 ethos: one bad row never blanks the whole list, never throws).
- **Query freshness:** charts always read the workspace's **current** snapshot via `getCurrentSnapshot`,
  so they stay fresh as scans advance. `snapshotVersionAtCreate` is provenance/diagnostics only. The
  cache key uses the **current** `snapshotVersion`, so a new scan (which bumps it, ADR-4) yields a new
  key space — automatic invalidation, no busting.

## 6. Contracts

### `ChartConfigSchema` — discriminated union on `shape`

A shared `MetricRequestSchema` (a resolved, validated `NamedMetricRequest`) is embedded in every shape:

```
MetricRequestSchema = {
  metric: NamedMetric           // reuse existing NamedMetricSchema: count | sum | average | revenue
  measureFieldId?: string       // required for sum/average/revenue (a lone measure)
  classification?: string       // REQUIRED when metric === 'revenue'; resolved from the mapping at build
}
// refine: revenue ⇒ measureFieldId present AND classification present
//         sum/average ⇒ measureFieldId present
```

- `categorical`: `{ shape:'categorical', metric: MetricRequest, groupByFieldId, groupByKind:'dimension'|'status', topN (int 1..50, default 20), renderer:'bar'|'pie' (default 'bar') }`
- `timeseries`: `{ shape:'timeseries', metric: MetricRequest, bucket:'day'|'week'|'month', renderer:'line' (default 'line') }`
- `kpi`: `{ shape:'kpi', metric: MetricRequest }`

`groupByKind` is stored explicitly (resolved by `chart-builder`) so aggregation reads exactly one bucket
(`mappedFields.dimensions` **or** `mappedFields.status`) with no "look in either" ambiguity.

**Revenue classification source:** baked into `config.metric.classification` at build time by
`chart-builder` (read from `DatabaseMapping.classification`). Aggregation therefore needs **no** DB
round-trip for classification. *Tradeoff:* if the mapping is later reclassified, the chart must be
rebuilt to pick up the new classification — acceptable for MVP, noted here so it isn't a surprise.

### `ChartDataContractSchema` — versioned wire format (ADR-6)

Discriminated union on `kind`, mirroring the metric engine's honest-refusal pattern:

```
{ kind:'unsupported', version, reason }                         // runtime refusal, e.g. average over an empty record set
{ kind:'data', version, snapshotVersion, shape, ...payload }
```

**Two distinct "unsupported" channels — do not conflate:**

- **`chart-builder` refusal** (build time) — `buildChart` returns `{ kind:'unsupported', reason }` when a
  chart *cannot be defined* against the mapping (no such field, wrong role, no `occurredAt` for a
  timeseries, revenue without classification). The `Chart` is never created. This is **not** the
  contract type.
- **`ChartDataContract` `unsupported`** (runtime) — `aggregate` returns it when a *validly defined* chart
  cannot produce an honest number for the current snapshot, by passing through `resolveNamedMetric`'s
  refusal (e.g. `average` over zero records). Because `chart-builder` already validated the metric shape
  against the mapping, this is mostly the empty-set / pass-through case.

Shape-specific `payload`:

- categorical → `points: [{ label: string, value: number }]`, `truncated: boolean`, `omittedGroupCount: number`
- timeseries  → `granularity: 'day'|'week'|'month'`, `points: [{ bucket: string /* ISO date */, value: number }]`
- kpi         → `value: number`

`version` is a single exported `CHART_CONTRACT_VERSION` const (start at `1`). Established now so adding
chart types later never breaks an already-embedded contract.

## 7. Aggregation engine (`snapshot-query.aggregate`)

Pure, deterministic, dispatch on `config.shape`. It **groups, then delegates the number to
`resolveNamedMetric`** — it never sums/averages itself:

- **kpi** → `resolveNamedMetric(records, config.metric)` → wrap into `{kind:'data', shape:'kpi', value}`
  or pass through the `unsupported` reason.
- **categorical** → bucket records by `mappedFields[groupByKind][groupByFieldId].value`; null/missing →
  `"(Unspecified)"`; run `resolveNamedMetric` on each group's records. Sort groups **value desc, label
  asc**; cap at `topN`; set `truncated` + `omittedGroupCount` from the dropped tail.
- **timeseries** → key each record to its UTC `day`/`week`/`month` bucket; records whose `occurredAt`
  is `null` are **skipped**. Run `resolveNamedMetric` per bucket; emit **non-empty buckets only**, sorted
  **bucket asc**. (`aggregate` does *not* decide timeseries supportability from data — it cannot tell an
  unmapped `occurredAt` from an all-null column. `chart-builder` guarantees `occurredAt` is mapped before
  a timeseries `Chart` can exist. An all-null column therefore yields a valid `{kind:'data'}` with an
  empty `points` array — honest, not a refusal.)

**Metric-supportability is decided once, before grouping.** A chart whose `config.metric` cannot resolve
*in principle* is caught at build time by `chart-builder`. At runtime `aggregate` evaluates the metric
uniformly per group/bucket, so groups never silently disappear due to per-group metric refusal.

### Empty-snapshot behavior (explicit, by shape)

When the current snapshot has **zero records** for the chart's source:

- **categorical** → `{kind:'data'}` with **empty `points`**, `truncated:false`, `omittedGroupCount:0`.
  No groups exist, so the per-group metric is never invoked — emptiness is never a refusal.
- **timeseries** → `{kind:'data'}` with **empty `points`**. Same reasoning (no buckets).
- **kpi** → delegates straight to `resolveNamedMetric` over the empty set, so the *metric* decides:
  `count`/`sum`/`revenue` → `{kind:'data', value:0}` (a true zero); `average` → `{kind:'unsupported',
  reason:'average of an empty record set'}` (the engine's existing refusal — there is no honest average
  of nothing).

So the **only** path that turns emptiness into a top-level `{kind:'unsupported'}` is **KPI + average**;
categorical and timeseries always render an honest empty series.

## 8. Caching

- `cacheKey({ chartId, workspaceId, normalizedFilterSet, snapshotVersion }) → string` — pure,
  `chartId:workspaceId:normalizedFilterSet:snapshotVersion` (ADR-4). `normalizedFilterSet` is `""` in
  this slice; config-filters fills it in.
- `queryChartData(deps, args)` — `deps` carries an **injected** cache interface (`get`/`set`) and the
  prisma client. **Flow (order matters — the key needs `snapshotVersion`, which only `getCurrentSnapshot`
  yields):** `getCurrentSnapshot` → build `cacheKey` from its returned `snapshotVersion` → cache `get` →
  **hit:** return cached contract → **miss:** `aggregate(records, config)` → cache `set` → return.
  Reading the snapshot first also makes the key race-free: the contract's `snapshotVersion` and the key's
  always agree, even if a scan commits mid-request. Unit-tested with a **fake** cache (hit + miss); no
  real Redis in this slice.
  - *Future optimization (not now):* on a cache hit this still reads records to learn the version. A
    later refinement can read just `workspace.snapshotVersion` (cheap, indexed) to build the key and skip
    the records read on a hit. Deferred to keep the slice simple and race-free.

## 9. Security

- **Tenant isolation (ADR-3):** every `lib/data/charts.ts` query and the snapshot read carry
  `workspaceId` in the WHERE. No data-access path without it. Tested.
- **No secrets, no Notion token** touched here (this slice never calls Notion).
- **Input validation (A03):** `ChartConfigSchema` validates at the persistence boundary; reads
  `safeParse` and skip-warn.

## 10. Testing (TDD — failing test first, every unit)

Pure functions dominate, so coverage is cheap and deterministic:

- **contracts** — `ChartConfigSchema` valid/invalid (revenue-without-classification rejected;
  topN bounds; groupByKind required); `ChartDataContractSchema` round-trips; `version` present.
- **aggregate** — categorical sort/tiebreak, top-N truncation + `omittedGroupCount`, `"(Unspecified)"`
  grouping & ordering; timeseries UTC bucketing for day/week/month, non-empty-only, asc, null-occurredAt
  rows skipped; kpi reuse; runtime `unsupported` pass-through (e.g. `average` over zero records).
- **aggregate (timeseries, all-null `occurredAt`)** → valid `{kind:'data'}` with empty `points` (not a
  refusal).
- **aggregate (empty snapshot, by shape)** → categorical & timeseries → `{kind:'data'}` empty `points`;
  kpi `count`/`sum`/`revenue` → `value:0`; kpi `average` → `{kind:'unsupported'}`.
- **chart-builder** — builds valid config from a mapping; refuses (`kind:'unsupported'`) when groupBy
  field absent / wrong role, measure absent, occurredAt absent (timeseries), classification absent
  (revenue); resolves `groupByKind` and bakes `classification`.
- **cacheKey** — determinism + version sensitivity.
- **queryChartData** — fake-cache hit and miss.
- **lib/data/charts** — tenant scoping (no cross-workspace read), shape-drift guard on write,
  skip-warn on a corrupt stored row.

## 11. Risks / notes

- **Stale baked classification** (see §6) — rebuild chart to refresh; acceptable for MVP.
- **`normalizedFilterSet` placeholder** — `""` here; config-filters must keep the same normalization so
  cache keys stay stable across the two slices.
- **`getCurrentSnapshot` refactor** touches an M4-consumed function (`getCurrentSnapshotRecords`); keep
  its existing signature/behavior intact (delegate) so reports are unaffected — covered by existing M4
  tests plus a new test on the helper.
