# M3 Truth Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn approved schema mappings into a deterministic, queryable source of typed numbers — full-row ingestion into a versioned `NormalizedRecord` table plus a pure-function metric engine — built and refreshed via an explicit, tracked BullMQ snapshot job.

**Architecture:** A user-triggered `SnapshotRun` enqueues `runSnapshot`, which paginates the full typed dataset of every approved database, normalizes each row into `mappedFields` + `occurredAt`, writes candidate rows at `snapshotVersion = N+1`, and **all-or-nothing** bumps `Workspace.snapshotVersion` only if every database succeeds (retaining current + previous). A pure metric engine (primitives + a conservative named resolver) reads the current snapshot via a workspace-scoped data-access seam. No AI runs in M3; the engine is the source of truth.

**Tech Stack:** Next.js 16 (App Router) route handlers, TypeScript, Prisma + Postgres, BullMQ + Redis, zod contracts, Vitest. Follows the existing M2 scan pipeline patterns (`lib/jobs/queue.ts`, `lib/jobs/run-scan.ts`, `lib/data/scan-runs.ts`, `app/api/scan/*`).

**Spec:** `docs/superpowers/specs/2026-06-12-notioniq-m3-truth-layer-design.md`

**Conventions (every task):** TDD — failing test → run (see it fail) → minimal impl → run (see it pass) → commit. Conventional commit `type(scope): subject` (lowercase, imperative, no trailing period, no task/PR numbers). Author is the repo owner; **no AI/co-author attribution**. Run on a feature branch (`truth-layer` already exists for this work). Every data-access function is workspace-scoped (ADR-3).

**Run a single test file:** `npx vitest run <path>` · **All gates before PR:** `npm run typecheck && npm run lint && npm run test && npm run build`

---

## File Structure

**New files:**
- `lib/contracts/normalized.ts` — `TypedValue`/`TypedRow` (discriminated), `MappedFields`, `NormalizedRecordInput`, `MetricRecord` (zod; shared API ↔ engine).
- `lib/contracts/snapshot-run.ts` — `SnapshotRunStatus` enum + `SnapshotRunResults` (per-DB) zod contract.
- `lib/contracts/metrics.ts` — metric request + `MetricResult` discriminated union (`value` | `unsupported`).
- `lib/notion/typed-reader.ts` — `collectTypedRows(client, databaseId)` full-pagination helper.
- `lib/normalize/normalize-row.ts` — pure `normalizeRow(typedRow, approvedMapping)`.
- `lib/metrics/primitives.ts` — `count`/`sum`/`avg`/`min`/`max`/`groupBy`/`bucketByTime`.
- `lib/metrics/named.ts` — conservative `resolveNamedMetric`.
- `lib/data/normalized.ts` — `writeSnapshotRecords`/`commitSnapshot`/`cleanOrphanCandidates`/`getCurrentSnapshotRecords`.
- `lib/data/snapshot-runs.ts` — `createSnapshotRun`/`getSnapshotRunForWorkspace`/`setSnapshotRunStatus`.
- `lib/jobs/snapshot-queue.ts` — `SNAPSHOT_QUEUE`, `SnapshotJob`, `enqueueSnapshot`.
- `lib/jobs/run-snapshot.ts` — pure `runSnapshot(deps, snapshotRunId)` handler.
- `app/api/snapshot/route.ts` — `POST` (create run + enqueue).
- `app/api/snapshot/[id]/route.ts` — `GET` (read run, workspace-scoped).
- `app/app/scan/snapshot-view.ts` — pure CTA/progress view-model helpers.
- Plus matching `*.test.ts` for each of the above (except the wiring-only files noted below).

**Modified files:**
- `prisma/schema.prisma` — add `NormalizedRecord` + `SnapshotRun` models and back-relations.
- `prisma/schema.test.ts` — assert the two new models generate.
- `lib/notion/notion-client.ts` — add `queryDatabaseRowsTyped` + typed-value extraction.
- `lib/data/mappings.ts` — add `listApprovedMappings`.
- `lib/jobs/worker.ts` — register the snapshot worker (wiring; verified by typecheck/build, no unit test — mirrors the untested scan worker).
- `app/app/scan/scan-client.tsx` — add the Build/Refresh-snapshot CTA + poll (presentational glue; verified by typecheck/build, per spec §10).

---

## Task 1: Prisma models + migration

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `prisma/schema.test.ts`
- Create: `prisma/migrations/0003_truth_layer_init/migration.sql`

- [ ] **Step 1: Write the failing test**

Add to `prisma/schema.test.ts` (inside the existing `describe('prisma schema', ...)`):

```ts
  it('generates the normalizedRecord and snapshotRun models', () => {
    expect(Object.keys(Prisma.ModelName)).toEqual(
      expect.arrayContaining(['NormalizedRecord', 'SnapshotRun']),
    )
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run prisma/schema.test.ts`
Expected: FAIL — array does not contain `NormalizedRecord`/`SnapshotRun`.

- [ ] **Step 3: Add the models to `prisma/schema.prisma`**

Append two models and add the two back-relations to `Workspace`. Inside `model Workspace { ... }`, add these lines beside the existing relations (`members`, `notionConnection`, `scanRuns`, `databaseMappings`):

```prisma
  normalizedRecords NormalizedRecord[]
  snapshotRuns      SnapshotRun[]
```

Then append at the end of the file:

```prisma
model NormalizedRecord {
  id               String    @id @default(cuid())
  workspaceId      String // tenant scope (ADR-3) — always in the WHERE
  sourceDatabaseId String // the notionDatabaseId this row came from
  notionPageId     String // provenance back to the Notion row
  occurredAt       DateTime? // from approvedMapping.occurredAtPropertyId (nullable)
  snapshotVersion  Int // the version this row belongs to
  mappedFields     Json // typed values keyed by role + field
  createdAt        DateTime  @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, sourceDatabaseId, notionPageId, snapshotVersion]) // idempotent re-ingest
  @@index([workspaceId, snapshotVersion, sourceDatabaseId])
  @@index([workspaceId, snapshotVersion, occurredAt])
}

model SnapshotRun {
  id              String    @id @default(cuid())
  workspaceId     String // tenant scope (ADR-3)
  status          String    @default("queued") // queued | running | committed | partial | failed
  snapshotVersion Int? // candidate/committed version this run targeted (N+1)
  results         Json? // per-DB: [{ sourceDatabaseId, status, rowCount?, error? }]
  error           String? // run-level failure detail
  startedAt       DateTime? // set when the worker begins
  finishedAt      DateTime? // set on committed | partial | failed
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId])
}
```

- [ ] **Step 4: Generate the client and the migration**

Run: `npx prisma generate`
Then create `prisma/migrations/0003_truth_layer_init/migration.sql` with:

```sql
-- CreateTable
CREATE TABLE "NormalizedRecord" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceDatabaseId" TEXT NOT NULL,
    "notionPageId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "snapshotVersion" INTEGER NOT NULL,
    "mappedFields" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NormalizedRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SnapshotRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "snapshotVersion" INTEGER,
    "results" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SnapshotRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NormalizedRecord_workspaceId_sourceDatabaseId_notionPageId_snapshotVersion_key" ON "NormalizedRecord"("workspaceId", "sourceDatabaseId", "notionPageId", "snapshotVersion");
CREATE INDEX "NormalizedRecord_workspaceId_snapshotVersion_sourceDatabaseId_idx" ON "NormalizedRecord"("workspaceId", "snapshotVersion", "sourceDatabaseId");
CREATE INDEX "NormalizedRecord_workspaceId_snapshotVersion_occurredAt_idx" ON "NormalizedRecord"("workspaceId", "snapshotVersion", "occurredAt");
CREATE INDEX "SnapshotRun_workspaceId_idx" ON "SnapshotRun"("workspaceId");

-- AddForeignKey
ALTER TABLE "NormalizedRecord" ADD CONSTRAINT "NormalizedRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SnapshotRun" ADD CONSTRAINT "SnapshotRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run prisma/schema.test.ts`
Expected: PASS (all three `it` blocks).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/schema.test.ts prisma/migrations/0003_truth_layer_init
git commit -m "feat(db): add normalizedrecord and snapshotrun models"
```

---

## Task 2: Normalized contracts (`lib/contracts/normalized.ts`)

**Files:**
- Create: `lib/contracts/normalized.ts`
- Test: `lib/contracts/normalized.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { TypedValueSchema, MappedFieldsSchema, NormalizedRecordInputSchema } from './normalized'

describe('normalized contracts', () => {
  it('accepts each TypedValue variant', () => {
    for (const v of [
      { kind: 'number', value: 1 },
      { kind: 'text', value: 'x' },
      { kind: 'list', value: ['a', 'b'] },
      { kind: 'date', value: '2026-06-12T00:00:00.000Z' },
      { kind: 'empty' },
    ]) {
      expect(TypedValueSchema.parse(v)).toEqual(v)
    }
  })

  it('rejects a number TypedValue with a string value', () => {
    expect(TypedValueSchema.safeParse({ kind: 'number', value: 'x' }).success).toBe(false)
  })

  it('defaults the mappedFields buckets to empty objects', () => {
    expect(MappedFieldsSchema.parse({})).toEqual({ measures: {}, dimensions: {}, status: {} })
  })

  it('validates a normalized record input', () => {
    const input = {
      notionPageId: 'pg1',
      occurredAt: '2026-06-12T00:00:00.000Z',
      mappedFields: { measures: { f1: { name: 'Amount', value: 10 } }, dimensions: {}, status: {} },
      warnings: [],
    }
    expect(NormalizedRecordInputSchema.parse(input)).toEqual(input)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/contracts/normalized.test.ts`
Expected: FAIL — cannot find module `./normalized`.

- [ ] **Step 3: Write the contract**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/contracts/normalized.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/contracts/normalized.ts lib/contracts/normalized.test.ts
git commit -m "feat(contracts): add typed-value and normalized-record contracts"
```

---

## Task 3: Snapshot-run contract (`lib/contracts/snapshot-run.ts`)

**Files:**
- Create: `lib/contracts/snapshot-run.ts`
- Test: `lib/contracts/snapshot-run.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { SnapshotRunStatusSchema, SnapshotRunResultsSchema } from './snapshot-run'

describe('snapshot-run contract', () => {
  it('accepts the five run statuses', () => {
    for (const s of ['queued', 'running', 'committed', 'partial', 'failed']) {
      expect(SnapshotRunStatusSchema.parse(s)).toBe(s)
    }
  })

  it('rejects an unknown status', () => {
    expect(SnapshotRunStatusSchema.safeParse('done').success).toBe(false)
  })

  it('validates per-database results', () => {
    const results = [
      { sourceDatabaseId: 'db1', status: 'ingested', rowCount: 42 },
      { sourceDatabaseId: 'db2', status: 'failed', error: 'NOTION_ERROR' },
    ]
    expect(SnapshotRunResultsSchema.parse(results)).toEqual(results)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/contracts/snapshot-run.test.ts`
Expected: FAIL — cannot find module `./snapshot-run`.

- [ ] **Step 3: Write the contract**

```ts
import { z } from 'zod'

export const SnapshotRunStatusSchema = z.enum(['queued', 'running', 'committed', 'partial', 'failed'])
export type SnapshotRunStatus = z.infer<typeof SnapshotRunStatusSchema>

// Shared by the job (writes), the API (reads), and the UI (renders) — one contract, no loose Json.
export const SnapshotDbResultSchema = z.object({
  sourceDatabaseId: z.string().min(1),
  status: z.enum(['ingested', 'failed']),
  rowCount: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
})
export type SnapshotDbResult = z.infer<typeof SnapshotDbResultSchema>

export const SnapshotRunResultsSchema = z.array(SnapshotDbResultSchema)
export type SnapshotRunResults = z.infer<typeof SnapshotRunResultsSchema>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/contracts/snapshot-run.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/contracts/snapshot-run.ts lib/contracts/snapshot-run.test.ts
git commit -m "feat(contracts): add snapshot-run status and results contract"
```

---

## Task 4: Metrics contract (`lib/contracts/metrics.ts`)

**Files:**
- Create: `lib/contracts/metrics.ts`
- Test: `lib/contracts/metrics.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { MetricResultSchema } from './metrics'

describe('metrics contract', () => {
  it('accepts a value result', () => {
    expect(MetricResultSchema.parse({ kind: 'value', value: 1990 })).toEqual({ kind: 'value', value: 1990 })
  })

  it('accepts an unsupported result with a reason', () => {
    const r = { kind: 'unsupported', reason: 'ambiguous measure' }
    expect(MetricResultSchema.parse(r)).toEqual(r)
  })

  it('rejects an unsupported result without a reason', () => {
    expect(MetricResultSchema.safeParse({ kind: 'unsupported' }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/contracts/metrics.test.ts`
Expected: FAIL — cannot find module `./metrics`.

- [ ] **Step 3: Write the contract**

```ts
import { z } from 'zod'

// The engine returns a number OR an explicit refusal — it never guesses (spec D-7).
export const MetricResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: z.number() }),
  z.object({ kind: z.literal('unsupported'), reason: z.string().min(1) }),
])
export type MetricResult = z.infer<typeof MetricResultSchema>

export const NamedMetricSchema = z.enum(['count', 'sum', 'average', 'revenue'])
export type NamedMetric = z.infer<typeof NamedMetricSchema>

export interface NamedMetricRequest {
  metric: NamedMetric
  measureFieldIds?: string[]
  classification?: string
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/contracts/metrics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/contracts/metrics.ts lib/contracts/metrics.test.ts
git commit -m "feat(contracts): add metric result and request contract"
```

---

## Task 5: Typed Notion read path

**Files:**
- Modify: `lib/notion/notion-client.ts`
- Modify: `lib/notion/notion-client.test.ts`
- Create: `lib/notion/typed-reader.ts`
- Test: `lib/notion/typed-reader.test.ts`

- [ ] **Step 1: Write the failing test for `queryDatabaseRowsTyped`**

Add to `lib/notion/notion-client.test.ts`:

```ts
  it('queryDatabaseRowsTyped maps native types to typed values keyed by property id', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        results: [
          {
            id: 'pg1',
            properties: {
              Amount: { id: 'p1', type: 'number', number: 1990 },
              Region: { id: 'p2', type: 'select', select: { name: 'EMEA' } },
              Tags: { id: 'p3', type: 'multi_select', multi_select: [{ name: 'a' }, { name: 'b' }] },
              Closed: { id: 'p4', type: 'date', date: { start: '2026-06-12' } },
              Empty: { id: 'p5', type: 'number', number: null },
            },
          },
        ],
        next_cursor: null,
      }),
    )
    const client = createNotionClient({ ...base, fetchImpl })
    const { rows, nextCursor } = await client.queryDatabaseRowsTyped('db1', {})
    expect(nextCursor).toBeNull()
    expect(rows[0].notionPageId).toBe('pg1')
    expect(rows[0].values).toEqual({
      p1: { kind: 'number', value: 1990 },
      p2: { kind: 'text', value: 'EMEA' },
      p3: { kind: 'list', value: ['a', 'b'] },
      p4: { kind: 'date', value: '2026-06-12T00:00:00.000Z' },
      p5: { kind: 'empty' },
    })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/notion/notion-client.test.ts`
Expected: FAIL — `client.queryDatabaseRowsTyped is not a function`.

- [ ] **Step 3: Implement `queryDatabaseRowsTyped` + extraction**

In `lib/notion/notion-client.ts`, add the import of the typed contract at the top:

```ts
import type { TypedRow, TypedValue } from '@/lib/contracts/normalized'
```

Add this method inside the returned object (after `queryDatabaseRows`):

```ts
    async queryDatabaseRowsTyped(databaseId: string, args: { cursor?: string; pageSize?: number }): Promise<{ rows: TypedRow[]; nextCursor: string | null }> {
      const raw = (await call({ method: 'POST', path: `/databases/${databaseId}/query`, body: { start_cursor: args.cursor, page_size: args.pageSize ?? 100 } })) as {
        results: { id: string; properties: Record<string, Record<string, unknown>> }[]
        next_cursor: string | null
      }
      const rows: TypedRow[] = raw.results.map((row) => {
        const values: Record<string, TypedValue> = {}
        for (const def of Object.values(row.properties)) values[def.id as string] = toTypedValue(def)
        return { notionPageId: row.id, values }
      })
      return { rows, nextCursor: raw.next_cursor }
    },
```

Add these module-scope helpers at the bottom of the file (after `renderValue`):

```ts
// Map one Notion page-property object to a TypedValue. Unknown/unsupported types → empty
// (so coverage gaps are visible as empties rather than crashing — see spec §14).
function toTypedValue(def: Record<string, unknown>): TypedValue {
  const type = def.type as string
  const v = def[type]
  switch (type) {
    case 'number':
      return typeof v === 'number' ? { kind: 'number', value: v } : { kind: 'empty' }
    case 'title':
    case 'rich_text':
      return { kind: 'text', value: plainText(v) }
    case 'select':
    case 'status': {
      const name = (v as { name?: string } | null)?.name
      return name ? { kind: 'text', value: name } : { kind: 'empty' }
    }
    case 'multi_select':
      return { kind: 'list', value: ((v as { name: string }[]) ?? []).map((o) => o.name) }
    case 'relation':
    case 'people':
      return { kind: 'list', value: ((v as { id: string }[]) ?? []).map((o) => o.id) }
    case 'date': {
      const start = (v as { start?: string } | null)?.start
      const iso = start ? toUtcIso(start) : null
      return iso ? { kind: 'date', value: iso } : { kind: 'empty' }
    }
    default:
      return { kind: 'empty' }
  }
}

function plainText(v: unknown): string {
  return Array.isArray(v) ? v.map((x: { plain_text?: string }) => x.plain_text ?? '').join('') : ''
}

// Widen date-only to midnight UTC; convert datetimes to UTC. Invalid → null.
function toUtcIso(input: string): string | null {
  const d = new Date(input)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/notion/notion-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `collectTypedRows`**

Create `lib/notion/typed-reader.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { collectTypedRows } from './typed-reader'

describe('collectTypedRows', () => {
  it('paginates through every cursor and concatenates all rows', async () => {
    const queryDatabaseRowsTyped = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ notionPageId: 'a', values: {} }], nextCursor: 'c2' })
      .mockResolvedValueOnce({ rows: [{ notionPageId: 'b', values: {} }], nextCursor: null })
    const rows = await collectTypedRows({ queryDatabaseRowsTyped } as never, 'db1')
    expect(rows.map((r) => r.notionPageId)).toEqual(['a', 'b'])
    expect(queryDatabaseRowsTyped).toHaveBeenNthCalledWith(1, 'db1', { cursor: undefined })
    expect(queryDatabaseRowsTyped).toHaveBeenNthCalledWith(2, 'db1', { cursor: 'c2' })
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run lib/notion/typed-reader.test.ts`
Expected: FAIL — cannot find module `./typed-reader`.

- [ ] **Step 7: Implement `collectTypedRows`**

Create `lib/notion/typed-reader.ts`:

```ts
import type { createNotionClient } from './notion-client'
import type { TypedRow } from '@/lib/contracts/normalized'

type NotionClient = ReturnType<typeof createNotionClient>

// Full pull: page through a database to completion via the rate-limited typed reader.
export async function collectTypedRows(client: NotionClient, databaseId: string): Promise<TypedRow[]> {
  const all: TypedRow[] = []
  let cursor: string | undefined
  do {
    const { rows, nextCursor } = await client.queryDatabaseRowsTyped(databaseId, { cursor })
    all.push(...rows)
    cursor = nextCursor ?? undefined
  } while (cursor)
  return all
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run lib/notion/typed-reader.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/notion/notion-client.ts lib/notion/notion-client.test.ts lib/notion/typed-reader.ts lib/notion/typed-reader.test.ts
git commit -m "feat(notion): add typed full-row read path"
```

---

## Task 6: `normalizeRow` (pure)

**Files:**
- Create: `lib/normalize/normalize-row.ts`
- Test: `lib/normalize/normalize-row.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { normalizeRow } from './normalize-row'
import type { TypedRow } from '@/lib/contracts/normalized'
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'

function field(over: Partial<DatabaseMappingProposal['fields'][number]>) {
  return { notionPropertyId: 'x', name: 'X', notionType: 't', candidateRole: 'ignore', role: 'ignore', confidence: 1, rationale: '', ...over } as DatabaseMappingProposal['fields'][number]
}
function mapping(over: Partial<DatabaseMappingProposal> = {}): DatabaseMappingProposal {
  return { classification: 'sales', occurredAtPropertyId: 'p4', fields: [], modelVersion: 'm', promptVersion: 'p', ...over }
}

const row: TypedRow = {
  notionPageId: 'pg1',
  values: {
    p1: { kind: 'number', value: 1990 },
    p2: { kind: 'text', value: 'EMEA' },
    p3: { kind: 'text', value: 'Won' },
    p4: { kind: 'date', value: '2026-06-12T00:00:00.000Z' },
    p5: { kind: 'text', value: 'Acme renewal' },
  },
}

describe('normalizeRow', () => {
  it('routes each role into its bucket and promotes occurredAt', () => {
    const out = normalizeRow(row, mapping({ fields: [
      field({ notionPropertyId: 'p1', name: 'Amount', role: 'measure' }),
      field({ notionPropertyId: 'p2', name: 'Region', role: 'dimension' }),
      field({ notionPropertyId: 'p3', name: 'Stage', role: 'status' }),
      field({ notionPropertyId: 'p4', name: 'Closed', role: 'date' }),
      field({ notionPropertyId: 'p5', name: 'Name', role: 'title' }),
    ] }))
    expect(out.notionPageId).toBe('pg1')
    expect(out.occurredAt).toBe('2026-06-12T00:00:00.000Z')
    expect(out.mappedFields).toEqual({
      measures: { p1: { name: 'Amount', value: 1990 } },
      dimensions: { p2: { name: 'Region', value: 'EMEA' } },
      status: { p3: { name: 'Stage', value: 'Won' } },
      title: { value: 'Acme renewal' },
    })
    expect(out.warnings).toEqual([])
  })

  it('drops ignore fields', () => {
    const out = normalizeRow(row, mapping({ occurredAtPropertyId: null, fields: [field({ notionPropertyId: 'p1', role: 'ignore' })] }))
    expect(out.mappedFields.measures).toEqual({})
  })

  it('leaves occurredAt null with no warning when the cell is empty', () => {
    const r: TypedRow = { notionPageId: 'pg1', values: { p4: { kind: 'empty' } } }
    const out = normalizeRow(r, mapping({ fields: [] }))
    expect(out.occurredAt).toBeNull()
    expect(out.warnings).toEqual([])
  })

  it('records a warning when occurredAt points at an unparseable date', () => {
    const r: TypedRow = { notionPageId: 'pg1', values: { p4: { kind: 'text', value: 'not-a-date' } } }
    const out = normalizeRow(r, mapping({ fields: [] }))
    expect(out.occurredAt).toBeNull()
    expect(out.warnings).toContain('occurredAt: unparseable date "not-a-date"')
  })

  it('drops an unparseable/empty measure and warns', () => {
    const r: TypedRow = { notionPageId: 'pg1', values: { p1: { kind: 'empty' } } }
    const out = normalizeRow(r, mapping({ occurredAtPropertyId: null, fields: [field({ notionPropertyId: 'p1', name: 'Amount', role: 'measure' })] }))
    expect(out.mappedFields.measures).toEqual({})
    expect(out.warnings).toContain('measure Amount: missing or non-numeric value')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/normalize/normalize-row.test.ts`
Expected: FAIL — cannot find module `./normalize-row`.

- [ ] **Step 3: Implement `normalizeRow`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/normalize/normalize-row.test.ts`
Expected: PASS (all six cases).

- [ ] **Step 5: Commit**

```bash
git add lib/normalize/normalize-row.ts lib/normalize/normalize-row.test.ts
git commit -m "feat(normalize): add pure row normalizer with warnings"
```

---

## Task 7: Metric primitives (pure)

**Files:**
- Create: `lib/metrics/primitives.ts`
- Test: `lib/metrics/primitives.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { count, sum, avg, min, max, groupBy, bucketByTime } from './primitives'
import type { MetricRecord } from '@/lib/contracts/normalized'

function rec(value: number, region: string, occurredAt: string | null): MetricRecord {
  return {
    occurredAt,
    mappedFields: {
      measures: { amt: { name: 'Amount', value } },
      dimensions: { reg: { name: 'Region', value: region } },
      status: {},
    },
  }
}

const recs: MetricRecord[] = [
  rec(10, 'EMEA', '2026-01-05T00:00:00.000Z'),
  rec(20, 'EMEA', '2026-01-20T00:00:00.000Z'),
  rec(30, 'AMER', '2026-02-03T00:00:00.000Z'),
]

describe('metric primitives', () => {
  it('count/sum/avg/min/max over a measure field', () => {
    expect(count(recs)).toBe(3)
    expect(sum(recs, 'amt')).toBe(60)
    expect(avg(recs, 'amt')).toBe(20)
    expect(min(recs, 'amt')).toBe(10)
    expect(max(recs, 'amt')).toBe(30)
  })

  it('sum ignores records missing the measure', () => {
    expect(sum([...recs, { occurredAt: null, mappedFields: { measures: {}, dimensions: {}, status: {} } }], 'amt')).toBe(60)
  })

  it('groupBy buckets records by a dimension value', () => {
    const g = groupBy(recs, 'reg')
    expect(Object.keys(g).sort()).toEqual(['AMER', 'EMEA'])
    expect(g.EMEA).toHaveLength(2)
  })

  it('bucketByTime groups by month and skips null occurredAt', () => {
    const withNull = [...recs, rec(5, 'EMEA', null)]
    const b = bucketByTime(withNull, 'month')
    expect(Object.keys(b).sort()).toEqual(['2026-01', '2026-02'])
    expect(b['2026-01']).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/metrics/primitives.test.ts`
Expected: FAIL — cannot find module `./primitives`.

- [ ] **Step 3: Implement the primitives**

```ts
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

export function min(records: MetricRecord[], fieldId: string): number {
  const vals = measureValues(records, fieldId)
  return vals.length === 0 ? 0 : Math.min(...vals)
}

export function max(records: MetricRecord[], fieldId: string): number {
  const vals = measureValues(records, fieldId)
  return vals.length === 0 ? 0 : Math.max(...vals)
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/metrics/primitives.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/metrics/primitives.ts lib/metrics/primitives.test.ts
git commit -m "feat(metrics): add deterministic aggregation primitives"
```

---

## Task 8: Named resolver (conservative)

**Files:**
- Create: `lib/metrics/named.ts`
- Test: `lib/metrics/named.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { resolveNamedMetric } from './named'
import type { MetricRecord } from '@/lib/contracts/normalized'

function rec(value: number): MetricRecord {
  return { occurredAt: null, mappedFields: { measures: { amt: { name: 'Amount', value } }, dimensions: {}, status: {} } }
}
const recs = [rec(10), rec(20)]

describe('resolveNamedMetric', () => {
  it('count is always supported', () => {
    expect(resolveNamedMetric(recs, { metric: 'count' })).toEqual({ kind: 'value', value: 2 })
  })

  it('sum resolves with exactly one measure field', () => {
    expect(resolveNamedMetric(recs, { metric: 'sum', measureFieldIds: ['amt'] })).toEqual({ kind: 'value', value: 30 })
  })

  it('sum refuses when the measure is ambiguous (zero or many)', () => {
    expect(resolveNamedMetric(recs, { metric: 'sum', measureFieldIds: [] }).kind).toBe('unsupported')
    expect(resolveNamedMetric(recs, { metric: 'sum', measureFieldIds: ['a', 'b'] }).kind).toBe('unsupported')
  })

  it('average refuses on an empty record set', () => {
    expect(resolveNamedMetric([], { metric: 'average', measureFieldIds: ['amt'] }).kind).toBe('unsupported')
  })

  it('revenue resolves only with a lone measure AND a classification', () => {
    expect(resolveNamedMetric(recs, { metric: 'revenue', measureFieldIds: ['amt'], classification: 'sales' })).toEqual({ kind: 'value', value: 30 })
    expect(resolveNamedMetric(recs, { metric: 'revenue', measureFieldIds: ['amt'] }).kind).toBe('unsupported')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/metrics/named.test.ts`
Expected: FAIL — cannot find module `./named`.

- [ ] **Step 3: Implement the resolver**

```ts
import type { MetricRecord } from '@/lib/contracts/normalized'
import type { MetricResult, NamedMetricRequest } from '@/lib/contracts/metrics'
import { count, sum, avg } from './primitives'

// Conservative (spec D-7): resolve only when evidence is unambiguous; otherwise refuse with a
// reason. Never guesses business meaning.
export function resolveNamedMetric(records: MetricRecord[], req: NamedMetricRequest): MetricResult {
  const ids = req.measureFieldIds ?? []
  const loneMeasure = ids.length === 1 ? ids[0] : null

  switch (req.metric) {
    case 'count':
      return { kind: 'value', value: count(records) }
    case 'sum':
      return loneMeasure
        ? { kind: 'value', value: sum(records, loneMeasure) }
        : { kind: 'unsupported', reason: 'sum requires exactly one measure field' }
    case 'average':
      if (!loneMeasure) return { kind: 'unsupported', reason: 'average requires exactly one measure field' }
      if (records.length === 0) return { kind: 'unsupported', reason: 'average of an empty record set' }
      return { kind: 'value', value: avg(records, loneMeasure) }
    case 'revenue':
      if (!loneMeasure || !req.classification) {
        return { kind: 'unsupported', reason: 'revenue requires a lone measure and a database classification' }
      }
      return { kind: 'value', value: sum(records, loneMeasure) }
    default:
      return { kind: 'unsupported', reason: 'unknown metric' }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/metrics/named.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/metrics/named.ts lib/metrics/named.test.ts
git commit -m "feat(metrics): add conservative named metric resolver"
```

---

## Task 9: Normalized data access + approved-mappings loader

**Files:**
- Create: `lib/data/normalized.ts`
- Test: `lib/data/normalized.test.ts`
- Modify: `lib/data/mappings.ts`
- Modify: `lib/data/mappings.test.ts`

- [ ] **Step 1: Write the failing test for `lib/data/normalized.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { writeSnapshotRecords, commitSnapshot, cleanOrphanCandidates, getCurrentSnapshotRecords } from './normalized'

function fakePrisma(over: Record<string, unknown> = {}) {
  return {
    normalizedRecord: {
      createMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
    },
    workspace: {
      findUniqueOrThrow: vi.fn(async () => ({ snapshotVersion: 2 })),
      update: vi.fn(async () => ({})),
    },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
    ...over,
  } as unknown as PrismaClient
}

describe('normalized data access', () => {
  it('writeSnapshotRecords bulk-inserts mapped rows for one db/version (idempotent)', async () => {
    const prisma = fakePrisma()
    await writeSnapshotRecords(prisma, {
      workspaceId: 'ws_1',
      sourceDatabaseId: 'db1',
      snapshotVersion: 3,
      records: [{ notionPageId: 'pg1', occurredAt: '2026-06-12T00:00:00.000Z', mappedFields: { measures: {}, dimensions: {}, status: {} }, warnings: [] }],
    })
    expect(prisma.normalizedRecord.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true, data: [expect.objectContaining({ workspaceId: 'ws_1', sourceDatabaseId: 'db1', notionPageId: 'pg1', snapshotVersion: 3 })] }),
    )
  })

  it('commitSnapshot bumps version and prunes < version-1 in one transaction', async () => {
    const prisma = fakePrisma()
    await commitSnapshot(prisma, { workspaceId: 'ws_1', version: 3 })
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.workspace.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'ws_1' }, data: { snapshotVersion: 3 } }))
    expect(prisma.normalizedRecord.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: 'ws_1', snapshotVersion: { lt: 2 } } }))
  })

  it('cleanOrphanCandidates deletes rows above the current version', async () => {
    const prisma = fakePrisma()
    await cleanOrphanCandidates(prisma, { workspaceId: 'ws_1', currentVersion: 2 })
    expect(prisma.normalizedRecord.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: 'ws_1', snapshotVersion: { gt: 2 } } })
  })

  it('getCurrentSnapshotRecords reads ONLY the workspace current version (never orphans)', async () => {
    const prisma = fakePrisma()
    await getCurrentSnapshotRecords(prisma, { workspaceId: 'ws_1' })
    expect(prisma.normalizedRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'ws_1', snapshotVersion: 2 } }),
    )
  })

  it('getCurrentSnapshotRecords maps stored rows into MetricRecords', async () => {
    const prisma = fakePrisma({
      workspace: { findUniqueOrThrow: vi.fn(async () => ({ snapshotVersion: 2 })) },
      normalizedRecord: {
        findMany: vi.fn(async () => [{ occurredAt: new Date('2026-06-12T00:00:00.000Z'), mappedFields: { measures: { amt: { name: 'Amount', value: 5 } }, dimensions: {}, status: {} } }]),
      },
    })
    const recs = await getCurrentSnapshotRecords(prisma, { workspaceId: 'ws_1' })
    expect(recs).toEqual([{ occurredAt: '2026-06-12T00:00:00.000Z', mappedFields: { measures: { amt: { name: 'Amount', value: 5 } }, dimensions: {}, status: {} } }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/data/normalized.test.ts`
Expected: FAIL — cannot find module `./normalized`.

- [ ] **Step 3: Implement `lib/data/normalized.ts`**

```ts
import type { PrismaClient, Prisma } from '@prisma/client'
import { MappedFieldsSchema, type MetricRecord, type NormalizedRecordInput } from '@/lib/contracts/normalized'

// Bulk-insert one database's normalized rows at a candidate version. skipDuplicates makes a
// re-ingest idempotent against the @@unique(workspace, db, page, version) constraint.
export async function writeSnapshotRecords(
  prisma: PrismaClient,
  args: { workspaceId: string; sourceDatabaseId: string; snapshotVersion: number; records: NormalizedRecordInput[] },
): Promise<void> {
  if (args.records.length === 0) return
  await prisma.normalizedRecord.createMany({
    skipDuplicates: true,
    data: args.records.map((r) => ({
      workspaceId: args.workspaceId,
      sourceDatabaseId: args.sourceDatabaseId,
      notionPageId: r.notionPageId,
      occurredAt: r.occurredAt ? new Date(r.occurredAt) : null,
      snapshotVersion: args.snapshotVersion,
      mappedFields: r.mappedFields as Prisma.InputJsonValue,
    })),
  })
}

// Atomic cutover (D-4/D-5): bump to the new version and prune everything older than the
// previous version, retaining current + previous only.
export async function commitSnapshot(prisma: PrismaClient, args: { workspaceId: string; version: number }): Promise<void> {
  await prisma.$transaction([
    prisma.workspace.update({ where: { id: args.workspaceId }, data: { snapshotVersion: args.version } }),
    prisma.normalizedRecord.deleteMany({ where: { workspaceId: args.workspaceId, snapshotVersion: { lt: args.version - 1 } } }),
  ])
}

// Drop leftover candidate rows from a prior failed attempt (version > current), at ingest start.
export async function cleanOrphanCandidates(prisma: PrismaClient, args: { workspaceId: string; currentVersion: number }): Promise<void> {
  await prisma.normalizedRecord.deleteMany({ where: { workspaceId: args.workspaceId, snapshotVersion: { gt: args.currentVersion } } })
}

// Read the live snapshot only — resolves the workspace's current version and filters to it, so
// orphaned N+1 candidates from a failed run are never returned. Always workspace-scoped (ADR-3).
export async function getCurrentSnapshotRecords(
  prisma: PrismaClient,
  args: { workspaceId: string; sourceDatabaseId?: string },
): Promise<MetricRecord[]> {
  const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: args.workspaceId }, select: { snapshotVersion: true } })
  const rows = await prisma.normalizedRecord.findMany({
    where: { workspaceId: args.workspaceId, snapshotVersion: ws.snapshotVersion, ...(args.sourceDatabaseId ? { sourceDatabaseId: args.sourceDatabaseId } : {}) },
  })
  return rows.map((r) => ({
    occurredAt: r.occurredAt ? r.occurredAt.toISOString() : null,
    mappedFields: MappedFieldsSchema.parse(r.mappedFields),
  }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/data/normalized.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `listApprovedMappings`**

Add to `lib/data/mappings.test.ts` (import it alongside the others at the top: `import { ..., listApprovedMappings } from './mappings'`). If `mappings.test.ts` has no prisma fake yet, add one in the new test:

```ts
import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { listApprovedMappings } from './mappings'

describe('listApprovedMappings', () => {
  it('returns approved databases with their approved mapping, workspace-scoped', async () => {
    const findMany = vi.fn(async () => [{ notionDatabaseId: 'db1', approvedMapping: { classification: 'sales', occurredAtPropertyId: null, fields: [], modelVersion: 'm', promptVersion: 'p' } }])
    const prisma = { databaseMapping: { findMany } } as unknown as PrismaClient
    const out = await listApprovedMappings(prisma, 'ws_1')
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: 'ws_1', status: 'approved' } }))
    expect(out[0].notionDatabaseId).toBe('db1')
    expect(out[0].approvedMapping.classification).toBe('sales')
  })

  it('skips approved rows with a null approvedMapping', async () => {
    const findMany = vi.fn(async () => [{ notionDatabaseId: 'db1', approvedMapping: null }])
    const prisma = { databaseMapping: { findMany } } as unknown as PrismaClient
    expect(await listApprovedMappings(prisma, 'ws_1')).toEqual([])
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run lib/data/mappings.test.ts`
Expected: FAIL — `listApprovedMappings` is not exported.

- [ ] **Step 7: Implement `listApprovedMappings` in `lib/data/mappings.ts`**

Add the import at the top if not present:

```ts
import { DatabaseMappingProposalSchema } from '@/lib/contracts/mapping'
```

Append:

```ts
// Approved databases for a workspace, with their approved mapping parsed back into the typed
// contract. Rows whose approvedMapping is null/invalid are skipped (defensive). ADR-3 scoped.
export async function listApprovedMappings(
  prisma: PrismaClient,
  workspaceId: string,
): Promise<{ notionDatabaseId: string; approvedMapping: DatabaseMappingProposal }[]> {
  const rows = await prisma.databaseMapping.findMany({
    where: { workspaceId, status: 'approved' },
    select: { notionDatabaseId: true, approvedMapping: true },
  })
  const out: { notionDatabaseId: string; approvedMapping: DatabaseMappingProposal }[] = []
  for (const r of rows) {
    const parsed = DatabaseMappingProposalSchema.safeParse(r.approvedMapping)
    if (parsed.success) out.push({ notionDatabaseId: r.notionDatabaseId, approvedMapping: parsed.data })
  }
  return out
}
```

Ensure `DatabaseMappingProposal` is imported as a type (it already is in this file).

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run lib/data/mappings.test.ts lib/data/normalized.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/data/normalized.ts lib/data/normalized.test.ts lib/data/mappings.ts lib/data/mappings.test.ts
git commit -m "feat(data): add normalized snapshot access and approved-mapping loader"
```

---

## Task 10: Snapshot-run data access (`lib/data/snapshot-runs.ts`)

**Files:**
- Create: `lib/data/snapshot-runs.ts`
- Test: `lib/data/snapshot-runs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { createSnapshotRun, getSnapshotRunForWorkspace, setSnapshotRunStatus } from './snapshot-runs'

function fakePrisma(over: Record<string, unknown> = {}) {
  return {
    snapshotRun: {
      create: vi.fn(async () => ({ id: 'run_1' })),
      findFirst: vi.fn(async () => ({ id: 'run_1', workspaceId: 'ws_1', status: 'committed' })),
      update: vi.fn(async () => ({ id: 'run_1' })),
    },
    ...over,
  } as unknown as PrismaClient
}

describe('snapshot-runs', () => {
  it('creates a queued run scoped to the workspace', async () => {
    const prisma = fakePrisma()
    const res = await createSnapshotRun(prisma, { workspaceId: 'ws_1' })
    expect(res).toEqual({ id: 'run_1' })
    expect(prisma.snapshotRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: { workspaceId: 'ws_1', status: 'queued' } }))
  })

  it('reads a run only within its workspace (tenant scoped)', async () => {
    const prisma = fakePrisma()
    await getSnapshotRunForWorkspace(prisma, { workspaceId: 'ws_1', snapshotRunId: 'run_1' })
    expect(prisma.snapshotRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'run_1', workspaceId: 'ws_1' } }))
  })

  it('marks a run running and stamps startedAt', async () => {
    const prisma = fakePrisma()
    await setSnapshotRunStatus(prisma, { snapshotRunId: 'run_1', status: 'running', markStarted: true })
    const data = (prisma.snapshotRun.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data
    expect(data.status).toBe('running')
    expect(data.startedAt).toBeInstanceOf(Date)
  })

  it('commits a run with version, results and finishedAt', async () => {
    const prisma = fakePrisma()
    await setSnapshotRunStatus(prisma, { snapshotRunId: 'run_1', status: 'committed', snapshotVersion: 3, results: [{ sourceDatabaseId: 'db1', status: 'ingested', rowCount: 2 }], markFinished: true })
    const data = (prisma.snapshotRun.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data
    expect(data).toEqual(expect.objectContaining({ status: 'committed', snapshotVersion: 3 }))
    expect(data.finishedAt).toBeInstanceOf(Date)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/data/snapshot-runs.test.ts`
Expected: FAIL — cannot find module `./snapshot-runs`.

- [ ] **Step 3: Implement `lib/data/snapshot-runs.ts`**

```ts
import type { PrismaClient, Prisma } from '@prisma/client'
import { SnapshotRunResultsSchema, type SnapshotRunStatus, type SnapshotRunResults } from '@/lib/contracts/snapshot-run'

export async function createSnapshotRun(prisma: PrismaClient, input: { workspaceId: string }): Promise<{ id: string }> {
  return prisma.snapshotRun.create({ data: { workspaceId: input.workspaceId, status: 'queued' }, select: { id: true } })
}

export async function getSnapshotRunForWorkspace(prisma: PrismaClient, args: { workspaceId: string; snapshotRunId: string }) {
  return prisma.snapshotRun.findFirst({ where: { id: args.snapshotRunId, workspaceId: args.workspaceId } })
}

// Single update used across the lifecycle. results is validated against the shared contract
// before persisting; markStarted/markFinished stamp timestamps so the pure handler stays
// deterministic (no Date in run-snapshot.ts).
export async function setSnapshotRunStatus(
  prisma: PrismaClient,
  args: {
    snapshotRunId: string
    status: SnapshotRunStatus
    snapshotVersion?: number
    results?: SnapshotRunResults
    error?: string
    markStarted?: boolean
    markFinished?: boolean
  },
): Promise<void> {
  const results = args.results ? SnapshotRunResultsSchema.parse(args.results) : undefined
  await prisma.snapshotRun.update({
    where: { id: args.snapshotRunId },
    data: {
      status: args.status,
      snapshotVersion: args.snapshotVersion,
      results: results as Prisma.InputJsonValue | undefined,
      error: args.error,
      ...(args.markStarted ? { startedAt: new Date() } : {}),
      ...(args.markFinished ? { finishedAt: new Date() } : {}),
    },
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/data/snapshot-runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/data/snapshot-runs.ts lib/data/snapshot-runs.test.ts
git commit -m "feat(data): add snapshot-run lifecycle access"
```

---

## Task 11: Snapshot queue (`lib/jobs/snapshot-queue.ts`)

**Files:**
- Create: `lib/jobs/snapshot-queue.ts`
- Test: `lib/jobs/snapshot-queue.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { SNAPSHOT_QUEUE, snapshotJobPayload } from './snapshot-queue'

describe('snapshot-queue', () => {
  it('uses a dedicated queue name distinct from the scan queue', () => {
    expect(SNAPSHOT_QUEUE).toBe('workspace-snapshot')
  })
  it('builds a typed job payload', () => {
    expect(snapshotJobPayload('run_1')).toEqual({ snapshotRunId: 'run_1' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/jobs/snapshot-queue.test.ts`
Expected: FAIL — cannot find module `./snapshot-queue`.

- [ ] **Step 3: Implement `lib/jobs/snapshot-queue.ts`** (mirrors `queue.ts`)

```ts
import { Queue } from 'bullmq'
import { getEnv } from '@/lib/env'

export const SNAPSHOT_QUEUE = 'workspace-snapshot'

export interface SnapshotJob {
  snapshotRunId: string
}

export function snapshotJobPayload(snapshotRunId: string): SnapshotJob {
  return { snapshotRunId }
}

let queue: Queue | undefined
export function getSnapshotQueue(): Queue<SnapshotJob> {
  if (!queue) {
    queue = new Queue<SnapshotJob>(SNAPSHOT_QUEUE, {
      connection: { url: getEnv().REDIS_URL, maxRetriesPerRequest: null },
    })
  }
  return queue as Queue<SnapshotJob>
}

export async function enqueueSnapshot(snapshotRunId: string): Promise<void> {
  await getSnapshotQueue().add('snapshot', snapshotJobPayload(snapshotRunId), {
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: false,
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/jobs/snapshot-queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/jobs/snapshot-queue.ts lib/jobs/snapshot-queue.test.ts
git commit -m "feat(jobs): add dedicated snapshot queue"
```

---

## Task 12: `runSnapshot` handler (all-or-nothing) + integration test

**Files:**
- Create: `lib/jobs/run-snapshot.ts`
- Test: `lib/jobs/run-snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { runSnapshot, type RunSnapshotDeps } from './run-snapshot'
import { sum } from '@/lib/metrics/primitives'
import type { TypedRow } from '@/lib/contracts/normalized'
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'

const mapping: DatabaseMappingProposal = {
  classification: 'sales',
  occurredAtPropertyId: null,
  fields: [{ notionPropertyId: 'p1', name: 'Amount', notionType: 'number', candidateRole: 'measure', role: 'measure', confidence: 1, rationale: '' }],
  modelVersion: 'm',
  promptVersion: 'p',
}
const rows: TypedRow[] = [
  { notionPageId: 'pg1', values: { p1: { kind: 'number', value: 10 } } },
  { notionPageId: 'pg2', values: { p1: { kind: 'number', value: 20 } } },
]

function deps(over: Partial<RunSnapshotDeps> = {}): RunSnapshotDeps {
  return {
    loadRun: vi.fn(async () => ({ workspaceId: 'ws_1', currentVersion: 0 })),
    loadApprovedMappings: vi.fn(async () => [{ notionDatabaseId: 'db1', approvedMapping: mapping }]),
    cleanOrphans: vi.fn(async () => {}),
    read: vi.fn(async () => rows),
    write: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    ...over,
  }
}

describe('runSnapshot', () => {
  it('ingests every db, commits N+1, and marks the run committed', async () => {
    const d = deps()
    await runSnapshot(d, 'run_1')
    expect(d.cleanOrphans).toHaveBeenCalledWith('ws_1', 0)
    expect(d.write).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws_1', sourceDatabaseId: 'db1', snapshotVersion: 1 }))
    expect(d.commit).toHaveBeenCalledWith('ws_1', 1)
    expect(d.setStatus).toHaveBeenLastCalledWith('run_1', expect.objectContaining({ status: 'committed', snapshotVersion: 1, markFinished: true }))
  })

  it('refuses when there are no approved mappings', async () => {
    const d = deps({ loadApprovedMappings: vi.fn(async () => []) })
    await runSnapshot(d, 'run_1')
    expect(d.commit).not.toHaveBeenCalled()
    expect(d.setStatus).toHaveBeenLastCalledWith('run_1', expect.objectContaining({ status: 'failed' }))
  })

  it('does NOT commit when any db fails — old snapshot stays live (all-or-nothing)', async () => {
    const d = deps({
      loadApprovedMappings: vi.fn(async () => [
        { notionDatabaseId: 'db1', approvedMapping: mapping },
        { notionDatabaseId: 'db2', approvedMapping: mapping },
      ]),
      read: vi.fn(async (id: string) => { if (id === 'db2') throw new Error('notion down'); return rows }),
    })
    await runSnapshot(d, 'run_1')
    expect(d.commit).not.toHaveBeenCalled()
    expect(d.setStatus).toHaveBeenLastCalledWith('run_1', expect.objectContaining({ status: 'partial' }))
  })

  it('integration: normalized rows written for db1 sum to the right number', async () => {
    const stored: Parameters<RunSnapshotDeps['write']>[0][] = []
    const d = deps({ write: vi.fn(async (args) => { stored.push(args) }) })
    await runSnapshot(d, 'run_1')
    const recs = stored[0].records.map((r) => ({ occurredAt: r.occurredAt, mappedFields: r.mappedFields }))
    expect(sum(recs, 'p1')).toBe(30)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/jobs/run-snapshot.test.ts`
Expected: FAIL — cannot find module `./run-snapshot`.

- [ ] **Step 3: Implement `lib/jobs/run-snapshot.ts`**

```ts
import { normalizeRow } from '@/lib/normalize/normalize-row'
import type { TypedRow, NormalizedRecordInput } from '@/lib/contracts/normalized'
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'
import type { SnapshotRunStatus, SnapshotRunResults } from '@/lib/contracts/snapshot-run'
import { log } from '@/lib/log'

export interface RunSnapshotDeps {
  loadRun(snapshotRunId: string): Promise<{ workspaceId: string; currentVersion: number }>
  loadApprovedMappings(workspaceId: string): Promise<{ notionDatabaseId: string; approvedMapping: DatabaseMappingProposal }[]>
  cleanOrphans(workspaceId: string, currentVersion: number): Promise<void>
  read(notionDatabaseId: string): Promise<TypedRow[]>
  write(args: { workspaceId: string; sourceDatabaseId: string; snapshotVersion: number; records: NormalizedRecordInput[] }): Promise<void>
  commit(workspaceId: string, version: number): Promise<void>
  setStatus(snapshotRunId: string, args: { status: SnapshotRunStatus; snapshotVersion?: number; results?: SnapshotRunResults; error?: string; markStarted?: boolean; markFinished?: boolean }): Promise<void>
}

// All-or-nothing ingest (spec D-4). Bumps the live version only if every approved database
// succeeds; otherwise leaves the previous snapshot active and records partial/failed.
export async function runSnapshot(deps: RunSnapshotDeps, snapshotRunId: string): Promise<void> {
  try {
    const run = await deps.loadRun(snapshotRunId)
    await deps.setStatus(snapshotRunId, { status: 'running', markStarted: true })

    const mappings = await deps.loadApprovedMappings(run.workspaceId)
    if (mappings.length === 0) {
      await deps.setStatus(snapshotRunId, { status: 'failed', error: 'no approved mappings', markFinished: true })
      return
    }

    const target = run.currentVersion + 1
    await deps.cleanOrphans(run.workspaceId, run.currentVersion)

    const results: SnapshotRunResults = []
    let allOk = true
    for (const m of mappings) {
      try {
        const rows = await deps.read(m.notionDatabaseId)
        const records = rows.map((r) => normalizeRow(r, m.approvedMapping))
        await deps.write({ workspaceId: run.workspaceId, sourceDatabaseId: m.notionDatabaseId, snapshotVersion: target, records })
        results.push({ sourceDatabaseId: m.notionDatabaseId, status: 'ingested', rowCount: records.length })
      } catch (err) {
        allOk = false
        const code = (err as { code?: string }).code ?? 'INGEST_ERROR'
        log.error('snapshot_db_failed', { snapshotRunId, sourceDatabaseId: m.notionDatabaseId, errorCode: code })
        results.push({ sourceDatabaseId: m.notionDatabaseId, status: 'failed', error: code })
      }
    }

    if (allOk) {
      await deps.commit(run.workspaceId, target)
      await deps.setStatus(snapshotRunId, { status: 'committed', snapshotVersion: target, results, markFinished: true })
    } else {
      const anyOk = results.some((r) => r.status === 'ingested')
      await deps.setStatus(snapshotRunId, { status: anyOk ? 'partial' : 'failed', results, markFinished: true })
    }
  } catch {
    log.error('snapshot_run_failed', { snapshotRunId })
    await deps.setStatus(snapshotRunId, { status: 'failed', error: 'snapshot run failed', markFinished: true })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/jobs/run-snapshot.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add lib/jobs/run-snapshot.ts lib/jobs/run-snapshot.test.ts
git commit -m "feat(jobs): add all-or-nothing snapshot ingest handler"
```

---

## Task 13: Wire the snapshot worker (`lib/jobs/worker.ts`)

**Files:**
- Modify: `lib/jobs/worker.ts`

No unit test — this is process-wiring glue (the existing scan worker has no test either). Verified by typecheck + build.

- [ ] **Step 1: Add the snapshot worker registration**

Add these imports at the top of `lib/jobs/worker.ts`:

```ts
import { collectTypedRows } from '@/lib/notion/typed-reader'
import { listApprovedMappings } from '@/lib/data/mappings'
import { writeSnapshotRecords, commitSnapshot, cleanOrphanCandidates } from '@/lib/data/normalized'
import { setSnapshotRunStatus } from '@/lib/data/snapshot-runs'
import { runSnapshot, type RunSnapshotDeps } from './run-snapshot'
import { SNAPSHOT_QUEUE, type SnapshotJob } from './snapshot-queue'
```

Add a `buildSnapshotDeps` factory (after the existing `buildDeps`):

```ts
function buildSnapshotDeps(): RunSnapshotDeps {
  const prisma = getPrisma()
  const env = getEnv()
  return {
    async loadRun(snapshotRunId) {
      const run = await prisma.snapshotRun.findUniqueOrThrow({ where: { id: snapshotRunId }, include: { workspace: true } })
      return { workspaceId: run.workspaceId, currentVersion: run.workspace.snapshotVersion }
    },
    loadApprovedMappings: (workspaceId) => listApprovedMappings(prisma, workspaceId),
    cleanOrphans: (workspaceId, currentVersion) => cleanOrphanCandidates(prisma, { workspaceId, currentVersion }),
    async read(notionDatabaseId) {
      // Resolve the workspace from the database row, then decrypt its token for the typed pull.
      const mapping = await prisma.databaseMapping.findFirstOrThrow({ where: { notionDatabaseId }, include: { workspace: { include: { notionConnection: true } } } })
      const conn = mapping.workspace.notionConnection
      if (!conn) throw Object.assign(new Error('no connection'), { code: 'NO_CONNECTION' })
      const token = decryptToken(conn.encryptedToken, env.TOKEN_ENCRYPTION_KEY, conn.notionWorkspaceId)
      const client = createNotionClient({ token, rateLimiter: createRateLimiter({ ratePerSec: 3 }) })
      return collectTypedRows(client, notionDatabaseId)
    },
    write: (args) => writeSnapshotRecords(prisma, args),
    commit: (workspaceId, version) => commitSnapshot(prisma, { workspaceId, version }),
    setStatus: (snapshotRunId, args) => setSnapshotRunStatus(prisma, { snapshotRunId, ...args }),
  }
}
```

At the bottom, after the existing scan `new Worker<ScanJob>(...)` line, add:

```ts
new Worker<SnapshotJob>(SNAPSHOT_QUEUE, async (job) => runSnapshot(buildSnapshotDeps(), job.data.snapshotRunId), { connection })
```

- [ ] **Step 2: Verify typecheck + lint + build**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/jobs/worker.ts
git commit -m "feat(jobs): register the snapshot worker"
```

---

## Task 14: `POST /api/snapshot`

**Files:**
- Create: `app/api/snapshot/route.ts`
- Test: `app/api/snapshot/route.test.ts`

> **Next.js 16 note:** before writing this handler, read the route-handler guide under
> `node_modules/next/dist/docs/` to confirm the current `NextRequest`/`NextResponse` + `auth()` APIs. The code below mirrors the existing `app/api/scan/route.ts` already in this repo.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn(async () => ({ userId: 'user_1' })) }))
vi.mock('@/lib/prisma', () => ({ getPrisma: vi.fn(() => ({})) }))
vi.mock('@/lib/env', () => ({ getEnv: vi.fn(() => ({ NEXT_PUBLIC_APP_URL: 'https://app.test' })) }))
vi.mock('@/lib/data/connections', () => ({ getWorkspaceForUser: vi.fn(async () => ({ id: 'ws_1' })) }))
vi.mock('@/lib/data/mappings', () => ({ listApprovedMappings: vi.fn(async () => [{ notionDatabaseId: 'db1' }]) }))
vi.mock('@/lib/data/snapshot-runs', () => ({ createSnapshotRun: vi.fn(async () => ({ id: 'run_1' })) }))
vi.mock('@/lib/jobs/snapshot-queue', () => ({ enqueueSnapshot: vi.fn(async () => {}) }))

import { POST } from './route'
import { listApprovedMappings } from '@/lib/data/mappings'
import { enqueueSnapshot } from '@/lib/jobs/snapshot-queue'

function req() {
  return new Request('https://app.test/api/snapshot', { method: 'POST', headers: { origin: 'https://app.test' } }) as never
}

describe('POST /api/snapshot', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a run and enqueues when approved mappings exist', async () => {
    const res = await POST(req())
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ snapshotRunId: 'run_1' })
    expect(enqueueSnapshot).toHaveBeenCalledWith('run_1')
  })

  it('refuses with 400 when there are no approved mappings', async () => {
    vi.mocked(listApprovedMappings).mockResolvedValueOnce([])
    const res = await POST(req())
    expect(res.status).toBe(400)
    expect(enqueueSnapshot).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/api/snapshot/route.test.ts`
Expected: FAIL — cannot find module `./route`.

- [ ] **Step 3: Implement `app/api/snapshot/route.ts`** (mirrors `app/api/scan/route.ts`)

```ts
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getEnv } from '@/lib/env'
import { getPrisma } from '@/lib/prisma'
import { getWorkspaceForUser } from '@/lib/data/connections'
import { listApprovedMappings } from '@/lib/data/mappings'
import { createSnapshotRun } from '@/lib/data/snapshot-runs'
import { enqueueSnapshot } from '@/lib/jobs/snapshot-queue'
import { log } from '@/lib/log'

function isSameOrigin(req: NextRequest, appUrl: string): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return false
  try {
    return new URL(origin).host === new URL(appUrl).host
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req, getEnv().NEXT_PUBLIC_APP_URL)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const prisma = getPrisma()
  const workspace = await getWorkspaceForUser(prisma, userId)
  if (!workspace) return NextResponse.json({ error: 'no_workspace' }, { status: 400 })

  const approved = await listApprovedMappings(prisma, workspace.id)
  if (approved.length === 0) return NextResponse.json({ error: 'no_approved_mappings' }, { status: 400 })

  const run = await createSnapshotRun(prisma, { workspaceId: workspace.id })
  await enqueueSnapshot(run.id)
  log.info('snapshot_enqueued', { userId, workspaceId: workspace.id, snapshotRunId: run.id, databaseCount: approved.length })
  return NextResponse.json({ snapshotRunId: run.id }, { status: 202 })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/api/snapshot/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/snapshot/route.ts app/api/snapshot/route.test.ts
git commit -m "feat(api): add snapshot build endpoint"
```

---

## Task 15: `GET /api/snapshot/[id]`

**Files:**
- Create: `app/api/snapshot/[id]/route.ts`
- Test: `app/api/snapshot/[id]/route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn(async () => ({ userId: 'user_1' })) }))
vi.mock('@/lib/prisma', () => ({ getPrisma: vi.fn(() => ({})) }))
vi.mock('@/lib/data/connections', () => ({ getWorkspaceForUser: vi.fn(async () => ({ id: 'ws_1' })) }))
vi.mock('@/lib/data/snapshot-runs', () => ({ getSnapshotRunForWorkspace: vi.fn() }))

import { GET } from './route'
import { getSnapshotRunForWorkspace } from '@/lib/data/snapshot-runs'

const params = (id: string) => ({ params: Promise.resolve({ id }) })

describe('GET /api/snapshot/[id]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the run status and results for the caller workspace', async () => {
    vi.mocked(getSnapshotRunForWorkspace).mockResolvedValueOnce({ id: 'run_1', status: 'committed', snapshotVersion: 3, results: [{ sourceDatabaseId: 'db1', status: 'ingested', rowCount: 2 }] } as never)
    const res = await GET({} as never, params('run_1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ snapshotRunId: 'run_1', status: 'committed', snapshotVersion: 3, results: [{ sourceDatabaseId: 'db1', status: 'ingested', rowCount: 2 }] })
    expect(getSnapshotRunForWorkspace).toHaveBeenCalledWith({}, { workspaceId: 'ws_1', snapshotRunId: 'run_1' })
  })

  it('returns 404 for a run that is not in the caller workspace (no cross-tenant leak)', async () => {
    vi.mocked(getSnapshotRunForWorkspace).mockResolvedValueOnce(null)
    const res = await GET({} as never, params('run_other'))
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "app/api/snapshot/[id]/route.test.ts"`
Expected: FAIL — cannot find module `./route`.

- [ ] **Step 3: Implement `app/api/snapshot/[id]/route.ts`** (mirrors `app/api/scan/[scanRunId]/route.ts`)

```ts
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getPrisma } from '@/lib/prisma'
import { getWorkspaceForUser } from '@/lib/data/connections'
import { getSnapshotRunForWorkspace } from '@/lib/data/snapshot-runs'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params

  const prisma = getPrisma()
  const workspace = await getWorkspaceForUser(prisma, userId)
  if (!workspace) return NextResponse.json({ error: 'no_workspace' }, { status: 400 })

  const run = await getSnapshotRunForWorkspace(prisma, { workspaceId: workspace.id, snapshotRunId: id })
  if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  return NextResponse.json({ snapshotRunId: run.id, status: run.status, snapshotVersion: run.snapshotVersion ?? null, results: run.results ?? [] })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "app/api/snapshot/[id]/route.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "app/api/snapshot/[id]/route.ts" "app/api/snapshot/[id]/route.test.ts"
git commit -m "feat(api): add snapshot status endpoint"
```

---

## Task 16: Snapshot CTA view-model + UI wiring

**Files:**
- Create: `app/app/scan/snapshot-view.ts`
- Test: `app/app/scan/snapshot-view.test.ts`
- Modify: `app/app/scan/scan-client.tsx`

- [ ] **Step 1: Write the failing test for the view-model**

```ts
import { describe, it, expect } from 'vitest'
import { snapshotCtaLabel, snapshotProgressLabel, canBuildSnapshot } from './snapshot-view'

describe('snapshot-view', () => {
  it('labels the CTA build before the first snapshot, refresh after', () => {
    expect(snapshotCtaLabel(false)).toBe('Build data snapshot')
    expect(snapshotCtaLabel(true)).toBe('Refresh data snapshot')
  })

  it('enables building only when all required mappings are approved', () => {
    expect(canBuildSnapshot({ allApproved: true, building: false })).toBe(true)
    expect(canBuildSnapshot({ allApproved: false, building: false })).toBe(false)
    expect(canBuildSnapshot({ allApproved: true, building: true })).toBe(false)
  })

  it('summarizes per-database progress', () => {
    expect(snapshotProgressLabel({ status: 'running', results: [] })).toBe('Building snapshot…')
    expect(snapshotProgressLabel({ status: 'committed', results: [{ sourceDatabaseId: 'db1', status: 'ingested', rowCount: 5 }] })).toBe('Snapshot built — 1 database, 5 rows')
    expect(snapshotProgressLabel({ status: 'partial', results: [{ sourceDatabaseId: 'a', status: 'ingested', rowCount: 2 }, { sourceDatabaseId: 'b', status: 'failed' }] })).toBe('1 ingested, 1 failed — snapshot not updated')
    expect(snapshotProgressLabel({ status: 'failed', results: [] })).toBe('Snapshot build failed — previous data unchanged')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/app/scan/snapshot-view.test.ts`
Expected: FAIL — cannot find module `./snapshot-view`.

- [ ] **Step 3: Implement `app/app/scan/snapshot-view.ts`**

```ts
import type { SnapshotRunResults } from '@/lib/contracts/snapshot-run'

export function snapshotCtaLabel(hasCommittedSnapshot: boolean): string {
  return hasCommittedSnapshot ? 'Refresh data snapshot' : 'Build data snapshot'
}

export function canBuildSnapshot(args: { allApproved: boolean; building: boolean }): boolean {
  return args.allApproved && !args.building
}

export function snapshotProgressLabel(run: { status: string; results: SnapshotRunResults }): string {
  if (run.status === 'queued' || run.status === 'running') return 'Building snapshot…'
  const ingested = run.results.filter((r) => r.status === 'ingested')
  const failed = run.results.filter((r) => r.status === 'failed')
  if (run.status === 'committed') {
    const rows = ingested.reduce((a, r) => a + (r.rowCount ?? 0), 0)
    return `Snapshot built — ${ingested.length} database${ingested.length === 1 ? '' : 's'}, ${rows} rows`
  }
  if (run.status === 'partial') return `${ingested.length} ingested, ${failed.length} failed — snapshot not updated`
  return 'Snapshot build failed — previous data unchanged'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/app/scan/snapshot-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the CTA into `app/app/scan/scan-client.tsx`**

This is presentational glue over the tested view-model + endpoints (verified by typecheck/build). Make these additions:

(a) Extend the imports at the top:

```tsx
import { snapshotCtaLabel, snapshotProgressLabel, canBuildSnapshot } from './snapshot-view'
import type { SnapshotRunResults } from '@/lib/contracts/snapshot-run'
```

(b) Add snapshot state inside `ScanClient` (after the existing `const [approved, setApproved] = ...` line):

```tsx
  const [snapshotRunId, setSnapshotRunId] = useState<string | null>(null)
  const [snapshotStatus, setSnapshotStatus] = useState<string>('idle')
  const [snapshotResults, setSnapshotResults] = useState<SnapshotRunResults>([])
  const [hasSnapshot, setHasSnapshot] = useState(false)
```

(c) Add a poll effect (next to the existing scan-poll effect):

```tsx
  useEffect(() => {
    if (!snapshotRunId || ['committed', 'partial', 'failed'].includes(snapshotStatus)) return
    const t = setInterval(async () => {
      const r = await fetch(`/api/snapshot/${snapshotRunId}`).then((x) => x.json())
      setSnapshotStatus(r.status)
      setSnapshotResults(r.results ?? [])
      if (r.status === 'committed') setHasSnapshot(true)
    }, 1500)
    return () => clearInterval(t)
  }, [snapshotRunId, snapshotStatus])
```

(d) Add the build action:

```tsx
  async function buildSnapshot() {
    const res = await fetch('/api/snapshot', { method: 'POST', headers: { 'content-type': 'application/json' } })
    if (!res.ok) return
    const data = await res.json()
    setSnapshotRunId(data.snapshotRunId)
    setSnapshotStatus('queued')
    setSnapshotResults([])
  }
```

(e) Render the CTA. The review section maps over `mappings` and tracks `approved`. Add this block at the end of the review area (after the `mappings.map(...)` block, still inside the outer `<div className="space-y-6">`), gated on every reviewable mapping being approved:

```tsx
      {isReviewable(status) && mappings.length > 0 && (
        <div className="space-y-2 border-t pt-4">
          <button
            onClick={buildSnapshot}
            disabled={!canBuildSnapshot({ allApproved: mappings.every((m) => approved.has(m.id) || m.status === 'approved'), building: snapshotRunId !== null && !['committed', 'partial', 'failed'].includes(snapshotStatus) })}
            className="rounded bg-emerald-700 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {snapshotCtaLabel(hasSnapshot)}
          </button>
          {snapshotRunId && <p role="status" className="text-sm text-gray-600">{snapshotProgressLabel({ status: snapshotStatus, results: snapshotResults })}</p>}
        </div>
      )}
```

- [ ] **Step 6: Verify typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: clean (Next.js compiles the new `/api/snapshot` routes and the updated client).

- [ ] **Step 7: Commit**

```bash
git add app/app/scan/snapshot-view.ts app/app/scan/snapshot-view.test.ts app/app/scan/scan-client.tsx
git commit -m "feat(app): add build-snapshot cta and progress"
```

---

## Final verification

- [ ] **Run the full gate**

Run: `npm run typecheck && npm run lint && npm run test && npm run build`
Expected: all green. The full M3 truth layer is then complete: typed ingestion → normalized versioned records → all-or-nothing snapshot cutover → pure metric engine, triggered and tracked via `SnapshotRun`.

---

## Spec coverage map (self-review)

| Spec item | Task |
| --- | --- |
| §5 `NormalizedRecord` + `SnapshotRun` models, indexes, `@@unique` | 1 |
| §4 discriminated `TypedValue`/`TypedRow`, `NormalizedRecordInput`, `MappedFields`, `MetricRecord` | 2 |
| §4 `SnapshotRun.results` shared zod contract | 3 |
| §4 metrics request/result + `unsupported` variant | 4 |
| §4 `queryDatabaseRowsTyped` + UTC `date.value`; full pagination | 5 |
| §4 `normalizeRow` (role buckets, ignore dropped, invalid-date warning, bad-measure warning) | 6 |
| §4 primitives (count/sum/avg/min/max/groupBy/bucketByTime) | 7 |
| §4/D-7 conservative named resolver incl. refusals | 8 |
| §4 `lib/data/normalized.ts` write/commit/clean/read; failed-run isolation; `listApprovedMappings` | 9 |
| §4 `lib/data/snapshot-runs.ts` lifecycle (start/finish stamps, results validated) | 10 |
| §4/§12 dedicated `SNAPSHOT_QUEUE` | 11 |
| §4/§9 D-4 all-or-nothing `runSnapshot` + integration read-back | 12 |
| §4 second worker on the same Redis connection | 13 |
| §8 `POST /api/snapshot` (refuses with no approved mappings) | 14 |
| §6/§8 `GET /api/snapshot/[id]` (workspace-scoped, no cross-tenant leak) | 15 |
| §10 Build/Refresh CTA + per-db progress | 16 |
| §11 testing strategy (pure unit, typed extraction, data layer, integration, tenant scope) | distributed across 1–16 |
| D-5 retain current+previous, prune `< version-1`, no rollback API | 9 (commitSnapshot), spec note honored — no rollback code added |
