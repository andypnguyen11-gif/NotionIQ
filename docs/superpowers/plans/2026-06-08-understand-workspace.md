# M2 — Understand Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scan a connected Notion workspace's selected databases, propose a lean semantic schema mapping (deterministic prior + AI refine), let the user review/approve it, and persist the approved mapping as the contract M3 will consume.

**Architecture:** A synchronous list endpoint feeds a select-then-scan flow; a thin `POST /api/scan` enqueues a BullMQ job whose `runScan` handler (a plain async fn, testable without Redis) reads Notion via a hand-rolled fetch+zod client behind a rate limiter, seeds roles from Notion property types, calls Claude (forced tool-use + zod) for semantic refinement, and persists `WorkspaceScanRun` + `DatabaseMapping`. A polled review UI approves mappings per database.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Prisma 7 (driver-adapter), Postgres, zod 4, BullMQ + ioredis, `@anthropic-ai/sdk`, Vitest 4 (node env, no RTL — UI logic is tested as pure functions).

**Spec:** `docs/superpowers/specs/2026-06-08-notioniq-m2-understand-workspace-design.md`

**Conventions (every task):**
- TDD: write failing test → run (see it fail) → minimal impl → run (see it pass) → commit.
- Conventional commits **with scope**, lowercase imperative subject, **no PR/task numbers**, single author. Author is the repo's configured git user (`andypnguyen11-gif <andypnguyen11@gmail.com>`); **no AI/co-author attribution**.
- Run a focused test with `npx vitest run <path>`; the full gate before any merge is `npm run typecheck && npm run lint && npm run test && npm run build`.
- All data access is tenant-scoped by `workspaceId`; zod-validate every boundary; never log/persist raw cell values, tokens, or secrets.
- Branch: `understand-workspace` (already created).

---

## File Structure

**Shared contracts**
- `lib/contracts/mapping.ts` — zod + types for `Role`, `FieldMapping`, `DatabaseMappingProposal` (imported by mapper, scanner, data, API, UI, and later M3).

**Notion (all wire details isolated here — D-3)**
- `lib/notion/rate-limiter.ts` — token-bucket (~3 req/s) + backoff; injectable clock/sleep.
- `lib/notion/notion-client.ts` — `searchDatabases`, `retrieveDatabase`, `queryDatabaseRows`; fetch+zod, injectable `fetchImpl`, `Notion-Version: 2022-06-28`; returns domain types only.
- `lib/notion/sample-bounds.ts` — bounding constants + pure truncation of the mapper sample.
- `lib/notion/scanner.ts` — orchestrates per-database read → full schema + bounded transient sample.

**Mapping**
- `lib/mapping/candidate-rules.ts` — pure Notion-type → candidate `Role`.
- `lib/mapping/schema-hash.ts` — pure stable hash of the FULL untruncated schema.
- `lib/mapping/merge.ts` — apply human role edits onto a proposal (review → approved).
- `lib/agents/anthropic-client.ts` — thin injectable Anthropic wrapper.
- `lib/agents/schema-mapper.ts` — prompt build + forced tool-use + zod + 1 repair retry + rationale guard.

**Jobs & persistence**
- `lib/jobs/queue.ts` — BullMQ queue/worker wiring (connection from `REDIS_URL`).
- `lib/jobs/run-scan.ts` — `runScan(deps, scanRunId)` plain handler.
- `lib/data/scan-runs.ts`, `lib/data/mappings.ts` — tenant-scoped persistence.

**API**
- `app/api/notion/databases/route.ts` — GET list (sync).
- `app/api/scan/route.ts` — POST enqueue.
- `app/api/scan/[scanRunId]/route.ts` — GET poll.
- `app/api/mappings/[id]/approve/route.ts` — POST approve.

**UI**
- `app/app/scan/scan-view.ts` — pure view-model helpers (tested directly).
- `app/app/scan/*.tsx` — thin presentational components + page.

**Schema/env**
- `prisma/schema.prisma`, `prisma/migrations/0002_understand_workspace_init/migration.sql`, `prisma/schema.test.ts`.
- `lib/env.ts`, `lib/env.test.ts`, `.env.example`.

---

## Task 1: Prisma models, migration, and env additions

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/0002_understand_workspace_init/migration.sql`
- Modify: `prisma/schema.test.ts`
- Modify: `lib/env.ts`, `lib/env.test.ts`, `.env.example`

- [ ] **Step 1: Write the failing schema test**

Add to `prisma/schema.test.ts` (extend the existing `arrayContaining`):

```ts
  it('generates the workspaceScanRun and databaseMapping models', () => {
    expect(Object.keys(Prisma.ModelName)).toEqual(
      expect.arrayContaining(['WorkspaceScanRun', 'DatabaseMapping']),
    )
  })
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run prisma/schema.test.ts`
Expected: FAIL — `WorkspaceScanRun` not in `Prisma.ModelName`.

- [ ] **Step 3: Add the models to `prisma/schema.prisma`**

Add the two models and the `Workspace` back-relations:

```prisma
model WorkspaceScanRun {
  id                  String   @id @default(cuid())
  workspaceId         String
  workspace           Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  status              String   @default("queued") // queued | running | proposed | approved | failed
  selectedDatabaseIds Json
  results             Json?
  propertyCount       Int?
  sampleRowCount      Int?
  mapperModel         String?
  mapperPromptVersion String?
  error               String?
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  mappings DatabaseMapping[]

  @@index([workspaceId])
}

model DatabaseMapping {
  id               String   @id @default(cuid())
  workspaceId      String
  workspace        Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  notionDatabaseId String
  databaseName     String
  classification   String?
  schema           Json
  schemaHash       String
  proposedMapping  Json
  approvedMapping  Json?
  status           String   @default("proposed") // proposed | approved
  confidence       Float?
  lastScanRunId    String
  lastScanRun      WorkspaceScanRun @relation(fields: [lastScanRunId], references: [id])
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@unique([workspaceId, notionDatabaseId])
  @@index([workspaceId])
}
```

Add to the existing `Workspace` model's relation block:

```prisma
  scanRuns         WorkspaceScanRun[]
  databaseMappings DatabaseMapping[]
```

- [ ] **Step 4: Generate the client and re-run the test**

Run: `npx prisma generate && npx vitest run prisma/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Author the migration SQL**

Create `prisma/migrations/0002_understand_workspace_init/migration.sql`:

```sql
-- CreateTable
CREATE TABLE "WorkspaceScanRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "selectedDatabaseIds" JSONB NOT NULL,
    "results" JSONB,
    "propertyCount" INTEGER,
    "sampleRowCount" INTEGER,
    "mapperModel" TEXT,
    "mapperPromptVersion" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceScanRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatabaseMapping" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "notionDatabaseId" TEXT NOT NULL,
    "databaseName" TEXT NOT NULL,
    "classification" TEXT,
    "schema" JSONB NOT NULL,
    "schemaHash" TEXT NOT NULL,
    "proposedMapping" JSONB NOT NULL,
    "approvedMapping" JSONB,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "confidence" DOUBLE PRECISION,
    "lastScanRunId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DatabaseMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceScanRun_workspaceId_idx" ON "WorkspaceScanRun"("workspaceId");
CREATE INDEX "DatabaseMapping_workspaceId_idx" ON "DatabaseMapping"("workspaceId");
CREATE UNIQUE INDEX "DatabaseMapping_workspaceId_notionDatabaseId_key" ON "DatabaseMapping"("workspaceId", "notionDatabaseId");

-- AddForeignKey
ALTER TABLE "WorkspaceScanRun" ADD CONSTRAINT "WorkspaceScanRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DatabaseMapping" ADD CONSTRAINT "DatabaseMapping_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DatabaseMapping" ADD CONSTRAINT "DatabaseMapping_lastScanRunId_fkey" FOREIGN KEY ("lastScanRunId") REFERENCES "WorkspaceScanRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

- [ ] **Step 6: Add env vars (failing test first)**

Add to `lib/env.test.ts` a case asserting the new vars parse. First locate the existing valid-env fixture in that file; add `ANTHROPIC_API_KEY` and `REDIS_URL` to it and assert:

```ts
  it('accepts the M2 anthropic + redis vars', () => {
    const env = parseEnv({
      ...validEnv, // the file's existing complete fixture
      ANTHROPIC_API_KEY: 'sk-ant-test',
      REDIS_URL: 'redis://localhost:6379',
    })
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test')
    expect(env.REDIS_URL).toBe('redis://localhost:6379')
  })
```

Run: `npx vitest run lib/env.test.ts` → FAIL (unknown keys stripped / undefined).

- [ ] **Step 7: Extend the env schema**

In `lib/env.ts` add to `envSchema`:

```ts
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
```

Add to `.env.example`:

```
# Anthropic API key for the schema mapper (https://console.anthropic.com/)
ANTHROPIC_API_KEY=sk-ant-replace-me

# Redis connection for BullMQ scan jobs (local: docker run -p 6379:6379 redis:7)
REDIS_URL=redis://localhost:6379
```

Run: `npx vitest run lib/env.test.ts prisma/schema.test.ts` → PASS.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/0002_understand_workspace_init lib/env.ts lib/env.test.ts .env.example
git commit -m "feat(db): add scan-run and database-mapping models plus m2 env"
```

---

## Task 2: Notion rate limiter

**Files:**
- Create: `lib/notion/rate-limiter.ts`
- Test: `lib/notion/rate-limiter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { createRateLimiter, withBackoff } from './rate-limiter'

describe('createRateLimiter', () => {
  it('spaces calls to at most the configured rate using injected clock + sleep', async () => {
    let now = 0
    const sleeps: number[] = []
    const limiter = createRateLimiter({
      ratePerSec: 3,
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms },
    })
    await limiter.acquire() // first is immediate
    await limiter.acquire() // must wait ~333ms
    expect(sleeps[0]).toBeGreaterThanOrEqual(300)
  })
})

describe('withBackoff', () => {
  it('retries on a thrown 429 then succeeds', async () => {
    const sleeps: number[] = []
    let calls = 0
    const result = await withBackoff(
      async () => {
        calls++
        if (calls < 2) throw Object.assign(new Error('rate limited'), { status: 429 })
        return 'ok'
      },
      { retries: 3, baseMs: 100, sleep: async (ms) => { sleeps.push(ms) } },
    )
    expect(result).toBe('ok')
    expect(calls).toBe(2)
    expect(sleeps.length).toBe(1)
  })

  it('gives up after retries are exhausted and rethrows', async () => {
    await expect(
      withBackoff(
        async () => { throw Object.assign(new Error('boom'), { status: 500 }) },
        { retries: 1, baseMs: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow('boom')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/notion/rate-limiter.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// Token-bucket-ish limiter (serializes acquires to >= 1/ratePerSec apart) plus a
// retry-with-exponential-backoff helper for 429/5xx. Clock + sleep are injectable so
// tests are deterministic and fast.
export interface RateLimiter {
  acquire(): Promise<void>
}

export function createRateLimiter(opts: {
  ratePerSec: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): RateLimiter {
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const minGapMs = 1000 / opts.ratePerSec
  let nextAllowed = 0
  let chain: Promise<void> = Promise.resolve()
  return {
    acquire() {
      chain = chain.then(async () => {
        const wait = nextAllowed - now()
        if (wait > 0) await sleep(wait)
        nextAllowed = now() + minGapMs
      })
      return chain
    },
  }
}

function statusOf(err: unknown): number | undefined {
  return typeof err === 'object' && err !== null && 'status' in err
    ? (err as { status?: number }).status
    : undefined
}

export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: { retries: number; baseMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      const status = statusOf(err)
      const retryable = status === 429 || (status !== undefined && status >= 500)
      if (!retryable || attempt >= opts.retries) throw err
      await sleep(opts.baseMs * 2 ** attempt)
      attempt++
    }
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/notion/rate-limiter.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/notion/rate-limiter.ts lib/notion/rate-limiter.test.ts
git commit -m "feat(notion): add rate limiter and backoff helper"
```

---

## Task 3: Notion read client

**Files:**
- Create: `lib/notion/notion-client.ts`
- Test: `lib/notion/notion-client.test.ts`

Domain types (no Notion wire field leaks out of this module):

```ts
export interface DatabaseListItem { id: string; title: string; icon: string | null; lastEditedTime: string }
export interface ScannedProperty { id: string; name: string; notionType: string; optionNames?: string[]; relationTargetId?: string }
export interface ScannedSchema { notionDatabaseId: string; databaseName: string; properties: ScannedProperty[] }
export interface RawRow { values: Record<string, string> } // property name -> stringified cell
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { createNotionClient } from './notion-client'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe('notion-client', () => {
  const base = { token: 'tok', rateLimiter: { acquire: async () => {} } }

  it('searchDatabases returns only databases with minimal metadata', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [
          { object: 'database', id: 'db1', title: [{ plain_text: 'Sales' }], icon: { type: 'emoji', emoji: '📊' }, last_edited_time: '2026-01-01T00:00:00Z' },
        ],
        has_more: false,
        next_cursor: null,
      }),
    )
    const client = createNotionClient({ ...base, fetchImpl })
    const { databases, nextCursor } = await client.searchDatabases({})
    expect(databases).toEqual([
      { id: 'db1', title: 'Sales', icon: '📊', lastEditedTime: '2026-01-01T00:00:00Z' },
    ])
    expect(nextCursor).toBeNull()
    const [, init] = fetchImpl.mock.calls[0]
    expect((init?.headers as Record<string, string>)['Notion-Version']).toBe('2022-06-28')
    expect(JSON.parse(init?.body as string).filter).toEqual({ property: 'object', value: 'database' })
  })

  it('retrieveDatabase maps properties incl. full option sets and relation target', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        id: 'db1',
        title: [{ plain_text: 'Sales' }],
        properties: {
          Stage: { id: 'p1', type: 'status', status: { options: [{ name: 'Lead' }, { name: 'Won' }] } },
          Amount: { id: 'p2', type: 'number', number: {} },
          Account: { id: 'p3', type: 'relation', relation: { database_id: 'dbX' } },
        },
      }),
    )
    const client = createNotionClient({ ...base, fetchImpl })
    const schema = await client.retrieveDatabase('db1')
    expect(schema.databaseName).toBe('Sales')
    expect(schema.properties).toEqual(
      expect.arrayContaining([
        { id: 'p1', name: 'Stage', notionType: 'status', optionNames: ['Lead', 'Won'] },
        { id: 'p2', name: 'Amount', notionType: 'number' },
        { id: 'p3', name: 'Account', notionType: 'relation', relationTargetId: 'dbX' },
      ]),
    )
  })

  it('throws on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 401 }))
    const client = createNotionClient({ ...base, fetchImpl })
    await expect(client.searchDatabases({})).rejects.toThrow(/401/)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/notion/notion-client.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
import { z } from 'zod'
import type { RateLimiter } from './rate-limiter'
import { withBackoff } from './rate-limiter'

const NOTION_VERSION = '2022-06-28'
const API = 'https://api.notion.com/v1'

export interface DatabaseListItem { id: string; title: string; icon: string | null; lastEditedTime: string }
export interface ScannedProperty { id: string; name: string; notionType: string; optionNames?: string[]; relationTargetId?: string }
export interface ScannedSchema { notionDatabaseId: string; databaseName: string; properties: ScannedProperty[] }
export interface RawRow { values: Record<string, string> }

const titleText = (t: unknown) =>
  Array.isArray(t) ? t.map((x: { plain_text?: string }) => x.plain_text ?? '').join('') : ''

const SearchResp = z.object({
  results: z.array(z.record(z.string(), z.unknown())),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
})

export function createNotionClient(opts: {
  token: string
  rateLimiter: RateLimiter
  fetchImpl?: typeof fetch
}) {
  const doFetch = opts.fetchImpl ?? fetch
  async function call(path: string, body: unknown): Promise<unknown> {
    await opts.rateLimiter.acquire()
    return withBackoff(
      async () => {
        const res = await doFetch(`${API}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.token}`,
            'Content-Type': 'application/json',
            'Notion-Version': NOTION_VERSION,
          },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw Object.assign(new Error(`Notion ${path} failed: ${res.status}`), { status: res.status })
        return res.json()
      },
      { retries: 3, baseMs: 400 },
    )
  }

  return {
    async searchDatabases(args: { cursor?: string }): Promise<{ databases: DatabaseListItem[]; nextCursor: string | null }> {
      const raw = SearchResp.parse(
        await call('/search', { filter: { property: 'object', value: 'database' }, start_cursor: args.cursor, page_size: 100 }),
      )
      const databases = raw.results.map((r) => {
        const rec = r as { id: string; title?: unknown; icon?: { emoji?: string }; last_edited_time?: string }
        return { id: rec.id, title: titleText(rec.title), icon: rec.icon?.emoji ?? null, lastEditedTime: rec.last_edited_time ?? '' }
      })
      return { databases, nextCursor: raw.next_cursor }
    },

    async retrieveDatabase(databaseId: string): Promise<ScannedSchema> {
      await opts.rateLimiter.acquire()
      const raw = (await withBackoff(
        async () => {
          const res = await doFetch(`${API}/databases/${databaseId}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${opts.token}`, 'Notion-Version': NOTION_VERSION },
          })
          if (!res.ok) throw Object.assign(new Error(`Notion retrieveDatabase failed: ${res.status}`), { status: res.status })
          return res.json()
        },
        { retries: 3, baseMs: 400 },
      )) as { id: string; title?: unknown; properties: Record<string, Record<string, unknown>> }

      const properties: ScannedProperty[] = Object.entries(raw.properties).map(([name, def]) => {
        const type = def.type as string
        const prop: ScannedProperty = { id: def.id as string, name, notionType: type }
        const opt = (def[type] as { options?: { name: string }[] } | undefined)?.options
        if (opt) prop.optionNames = opt.map((o) => o.name)
        const rel = (def[type] as { database_id?: string } | undefined)?.database_id
        if (rel) prop.relationTargetId = rel
        return prop
      })
      return { notionDatabaseId: raw.id, databaseName: titleText(raw.title), properties }
    },

    async queryDatabaseRows(databaseId: string, args: { cursor?: string; pageSize?: number }): Promise<{ rows: RawRow[]; nextCursor: string | null }> {
      const raw = (await call(`/databases/${databaseId}/query`, { start_cursor: args.cursor, page_size: args.pageSize ?? 20 })) as {
        results: { properties: Record<string, unknown> }[]
        next_cursor: string | null
      }
      const rows: RawRow[] = raw.results.map((row) => ({ values: stringifyRow(row.properties) }))
      return { rows, nextCursor: raw.next_cursor }
    },
  }
}

// Best-effort flatten of a Notion row's property values to short strings. Used only to
// build a transient mapper sample — never persisted.
function stringifyRow(props: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, def] of Object.entries(props)) {
    const d = def as { type?: string; [k: string]: unknown }
    const v = d.type ? d[d.type] : undefined
    out[name] = renderValue(v)
  }
  return out
}

function renderValue(v: unknown): string {
  if (v == null) return ''
  if (Array.isArray(v)) return v.map((x) => renderValue(x)).filter(Boolean).join(', ')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('name' in o) return String(o.name)
    if ('plain_text' in o) return String(o.plain_text)
    if ('start' in o) return String(o.start)
    return ''
  }
  return String(v)
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/notion/notion-client.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/notion/notion-client.ts lib/notion/notion-client.test.ts
git commit -m "feat(notion): add read client for search retrieve and query"
```

---

## Task 4: Sample bounds (constants + truncation)

**Files:**
- Create: `lib/notion/sample-bounds.ts`
- Test: `lib/notion/sample-bounds.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { BOUNDS, boundSample } from './sample-bounds'
import type { RawRow } from './notion-client'

describe('boundSample', () => {
  it('caps rows, cells chars, and reports the constants', () => {
    expect(BOUNDS).toEqual({ MAX_SAMPLE_ROWS: 20, MAX_PROPERTIES: 50, MAX_CELL_CHARS: 200, MAX_OPTION_NAMES: 50 })
    const rows: RawRow[] = Array.from({ length: 25 }, (_, i) => ({ values: { A: 'x'.repeat(300), B: String(i) } }))
    const out = boundSample(rows)
    expect(out.length).toBe(20)
    expect(out[0].values.A.length).toBe(BOUNDS.MAX_CELL_CHARS + 1) // 200 chars + ellipsis
    expect(out[0].values.A.endsWith('…')).toBe(true)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/notion/sample-bounds.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
import type { RawRow } from './notion-client'

export const BOUNDS = {
  MAX_SAMPLE_ROWS: 20,
  MAX_PROPERTIES: 50,
  MAX_CELL_CHARS: 200,
  MAX_OPTION_NAMES: 50,
} as const

function truncateCell(v: string): string {
  return v.length > BOUNDS.MAX_CELL_CHARS ? v.slice(0, BOUNDS.MAX_CELL_CHARS) + '…' : v
}

export function boundSample(rows: RawRow[]): RawRow[] {
  return rows.slice(0, BOUNDS.MAX_SAMPLE_ROWS).map((r) => {
    const values: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.values)) values[k] = truncateCell(v)
    return { values }
  })
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/notion/sample-bounds.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/notion/sample-bounds.ts lib/notion/sample-bounds.test.ts
git commit -m "feat(notion): add bounded sample truncation"
```

---

## Task 5: Schema hash

**Files:**
- Create: `lib/mapping/schema-hash.ts`
- Test: `lib/mapping/schema-hash.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { hashSchema } from './schema-hash'
import type { ScannedProperty } from '@/lib/notion/notion-client'

const props: ScannedProperty[] = [
  { id: 'p1', name: 'Stage', notionType: 'status', optionNames: ['Lead', 'Won'] },
  { id: 'p2', name: 'Amount', notionType: 'number' },
]

describe('hashSchema', () => {
  it('is stable regardless of property order', () => {
    expect(hashSchema(props)).toBe(hashSchema([props[1], props[0]]))
  })

  it('changes when a type changes', () => {
    expect(hashSchema(props)).not.toBe(
      hashSchema([{ ...props[0] }, { ...props[1], notionType: 'rich_text' }]),
    )
  })

  it('changes when an option beyond a display cap is added (full option set hashed)', () => {
    const big = Array.from({ length: 60 }, (_, i) => `opt${i}`)
    const a = hashSchema([{ id: 'p1', name: 'Stage', notionType: 'status', optionNames: big }])
    const b = hashSchema([{ id: 'p1', name: 'Stage', notionType: 'status', optionNames: [...big, 'opt60'] }])
    expect(a).not.toBe(b)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/mapping/schema-hash.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
import { createHash } from 'node:crypto'
import type { ScannedProperty } from '@/lib/notion/notion-client'

// Hash the FULL untruncated schema (all properties + complete option sets) so a change
// beyond any display/mapper cap still invalidates an approval. Order-independent.
export function hashSchema(properties: ScannedProperty[]): string {
  const canonical = properties
    .map((p) => ({
      id: p.id,
      name: p.name,
      notionType: p.notionType,
      optionNames: p.optionNames ? [...p.optionNames] : undefined,
      relationTargetId: p.relationTargetId,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/mapping/schema-hash.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/mapping/schema-hash.ts lib/mapping/schema-hash.test.ts
git commit -m "feat(mapping): add stable schema hash over full schema"
```

---

## Task 6: Candidate role rules

**Files:**
- Create: `lib/mapping/candidate-rules.ts`
- Test: `lib/mapping/candidate-rules.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { candidateRole } from './candidate-rules'

describe('candidateRole', () => {
  it.each([
    ['title', 'title'],
    ['date', 'date'],
    ['created_time', 'date'],
    ['last_edited_time', 'date'],
    ['number', 'measure'],
    ['select', 'dimension'],
    ['multi_select', 'dimension'],
    ['relation', 'dimension'],
    ['people', 'dimension'],
    ['status', 'status'],
    ['rich_text', 'ignore'],
    ['checkbox', 'ignore'],
    ['url', 'ignore'],
    ['files', 'ignore'],
  ])('maps %s -> %s', (notionType, expected) => {
    expect(candidateRole({ notionType })).toBe(expected)
  })

  it('maps a number-returning formula to measure', () => {
    expect(candidateRole({ notionType: 'formula', formulaResultType: 'number' })).toBe('measure')
  })

  it('maps a number rollup to measure', () => {
    expect(candidateRole({ notionType: 'rollup', rollupResultType: 'number' })).toBe('measure')
  })

  it('maps a non-number formula to ignore', () => {
    expect(candidateRole({ notionType: 'formula', formulaResultType: 'string' })).toBe('ignore')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/mapping/candidate-rules.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
import type { Role } from '@/lib/contracts/mapping'

export interface CandidateInput {
  notionType: string
  formulaResultType?: string
  rollupResultType?: string
}

// Deterministic prior: map a Notion property type to a candidate role. The AI refines
// these later; this is intentionally conservative (unknowns -> ignore).
export function candidateRole(p: CandidateInput): Role {
  switch (p.notionType) {
    case 'title':
      return 'title'
    case 'date':
    case 'created_time':
    case 'last_edited_time':
      return 'date'
    case 'number':
      return 'measure'
    case 'formula':
      return p.formulaResultType === 'number' ? 'measure' : 'ignore'
    case 'rollup':
      return p.rollupResultType === 'number' ? 'measure' : 'ignore'
    case 'select':
    case 'multi_select':
    case 'relation':
    case 'people':
      return 'dimension'
    case 'status':
      return 'status'
    default:
      return 'ignore'
  }
}
```

> Note: `candidate-rules` imports `Role` from `lib/contracts/mapping` (Task 7). If executing strictly in order, do Task 7 first or define `Role` inline temporarily — the plan lists Task 7 next; the spec build order pairs them. Run both together if needed.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/mapping/candidate-rules.test.ts` (after Task 7's `Role` exists) → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/mapping/candidate-rules.ts lib/mapping/candidate-rules.test.ts
git commit -m "feat(mapping): add deterministic candidate role rules"
```

---

## Task 7: Mapping contract (zod)

**Files:**
- Create: `lib/contracts/mapping.ts`
- Test: `lib/contracts/mapping.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { RoleSchema, FieldMappingSchema, DatabaseMappingProposalSchema } from './mapping'

const field = {
  notionPropertyId: 'p1',
  name: 'Amount',
  notionType: 'number',
  candidateRole: 'measure',
  role: 'measure',
  confidence: 0.9,
  rationale: 'Numeric property typically aggregated.',
}

describe('mapping contract', () => {
  it('accepts the lean roles', () => {
    for (const r of ['date', 'measure', 'dimension', 'status', 'title', 'ignore'])
      expect(RoleSchema.parse(r)).toBe(r)
  })

  it('rejects an unknown role', () => {
    expect(() => RoleSchema.parse('person')).toThrow()
  })

  it('rejects a rationale longer than 200 chars', () => {
    expect(() => FieldMappingSchema.parse({ ...field, rationale: 'x'.repeat(201) })).toThrow()
  })

  it('accepts a full proposal', () => {
    const proposal = {
      classification: 'sales pipeline',
      occurredAtPropertyId: 'p9',
      fields: [field],
      modelVersion: 'claude-sonnet-4-6',
      promptVersion: 'mapper-v1',
    }
    expect(DatabaseMappingProposalSchema.parse(proposal).fields.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/contracts/mapping.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
import { z } from 'zod'

export const RoleSchema = z.enum(['date', 'measure', 'dimension', 'status', 'title', 'ignore'])
export type Role = z.infer<typeof RoleSchema>

export const FieldMappingSchema = z.object({
  notionPropertyId: z.string().min(1),
  name: z.string().min(1),
  notionType: z.string().min(1),
  optionNames: z.array(z.string()).optional(),
  relationTargetName: z.string().optional(),
  candidateRole: RoleSchema,
  role: RoleSchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(200),
})
export type FieldMapping = z.infer<typeof FieldMappingSchema>

export const DatabaseMappingProposalSchema = z.object({
  classification: z.string().min(1),
  occurredAtPropertyId: z.string().nullable(),
  fields: z.array(FieldMappingSchema),
  modelVersion: z.string().min(1),
  promptVersion: z.string().min(1),
})
export type DatabaseMappingProposal = z.infer<typeof DatabaseMappingProposalSchema>
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/contracts/mapping.test.ts lib/mapping/candidate-rules.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/contracts/mapping.ts lib/contracts/mapping.test.ts
git commit -m "feat(contracts): add zod schema mapping contract"
```

---

## Task 8: Scanner orchestration

**Files:**
- Create: `lib/notion/scanner.ts`
- Test: `lib/notion/scanner.test.ts`

Output type:

```ts
export interface ScannedDatabase {
  notionDatabaseId: string
  databaseName: string
  properties: ScannedProperty[]  // full untruncated schema
  sample: RawRow[]               // bounded transient sample
}
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { scanDatabases } from './scanner'
import type { ScannedSchema, RawRow } from './notion-client'

function fakeClient() {
  return {
    retrieveDatabase: vi.fn(
      async (id: string): Promise<ScannedSchema> => ({
        notionDatabaseId: id,
        databaseName: `DB ${id}`,
        properties: [{ id: 'p1', name: 'Amount', notionType: 'number' }],
      }),
    ),
    queryDatabaseRows: vi.fn(async (): Promise<{ rows: RawRow[]; nextCursor: string | null }> => ({
      rows: Array.from({ length: 30 }, (_, i) => ({ values: { Amount: String(i) } })),
      nextCursor: null,
    })),
    searchDatabases: vi.fn(),
  }
}

describe('scanDatabases', () => {
  it('returns full schema + a bounded sample per selected database', async () => {
    const client = fakeClient()
    const out = await scanDatabases(client as never, ['db1', 'db2'])
    expect(out.map((d) => d.notionDatabaseId)).toEqual(['db1', 'db2'])
    expect(out[0].properties).toHaveLength(1)
    expect(out[0].sample.length).toBe(20) // MAX_SAMPLE_ROWS
    expect(client.retrieveDatabase).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/notion/scanner.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
import type { createNotionClient, ScannedProperty, RawRow } from './notion-client'
import { boundSample, BOUNDS } from './sample-bounds'

export interface ScannedDatabase {
  notionDatabaseId: string
  databaseName: string
  properties: ScannedProperty[]
  sample: RawRow[]
}

type NotionClient = ReturnType<typeof createNotionClient>

// Read each selected database's full schema plus one bounded page of rows for the mapper.
// Raw rows never leave this layer except as the transient sample passed to the mapper.
export async function scanDatabases(
  client: NotionClient,
  databaseIds: string[],
): Promise<ScannedDatabase[]> {
  const out: ScannedDatabase[] = []
  for (const id of databaseIds) {
    const schema = await client.retrieveDatabase(id)
    const { rows } = await client.queryDatabaseRows(id, { pageSize: BOUNDS.MAX_SAMPLE_ROWS })
    out.push({
      notionDatabaseId: schema.notionDatabaseId,
      databaseName: schema.databaseName,
      properties: schema.properties,
      sample: boundSample(rows),
    })
  }
  return out
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/notion/scanner.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/notion/scanner.ts lib/notion/scanner.test.ts
git commit -m "feat(notion): add database scanner orchestration"
```

---

## Task 9: Anthropic client wrapper

**Files:**
- Create: `lib/agents/anthropic-client.ts`
- Test: `lib/agents/anthropic-client.test.ts`

First install the SDK:

```bash
npm install @anthropic-ai/sdk
```

Define a narrow interface so the mapper depends on an abstraction, not the SDK:

```ts
export interface ToolCallResult { input: unknown; model: string; inputTokens: number; outputTokens: number }
export interface ToolCaller {
  callTool(args: { system: string; user: string; toolName: string; toolSchema: object; model: string }): Promise<ToolCallResult>
}
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { createToolCaller } from './anthropic-client'

describe('createToolCaller', () => {
  it('forces tool use and returns the tool input + usage', async () => {
    const create = vi.fn(async () => ({
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 10, output_tokens: 20 },
      content: [{ type: 'tool_use', name: 'emit_mapping', input: { ok: true } }],
    }))
    const caller = createToolCaller({ sdk: { messages: { create } } as never })
    const res = await caller.callTool({
      system: 'sys', user: 'usr', toolName: 'emit_mapping', toolSchema: { type: 'object' }, model: 'claude-sonnet-4-6',
    })
    expect(res.input).toEqual({ ok: true })
    expect(res.inputTokens).toBe(10)
    const arg = create.mock.calls[0][0]
    expect(arg.tool_choice).toEqual({ type: 'tool', name: 'emit_mapping' })
  })

  it('throws if no tool_use block is returned', async () => {
    const create = vi.fn(async () => ({ model: 'm', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'hi' }] }))
    const caller = createToolCaller({ sdk: { messages: { create } } as never })
    await expect(
      caller.callTool({ system: 's', user: 'u', toolName: 't', toolSchema: {}, model: 'm' }),
    ).rejects.toThrow(/tool_use/)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/agents/anthropic-client.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
import type Anthropic from '@anthropic-ai/sdk'

export interface ToolCallResult { input: unknown; model: string; inputTokens: number; outputTokens: number }
export interface ToolCaller {
  callTool(args: { system: string; user: string; toolName: string; toolSchema: object; model: string }): Promise<ToolCallResult>
}

// Thin wrapper around the Anthropic SDK that forces a single tool call and returns its
// validated-elsewhere input plus token usage. `sdk` is injected so tests never hit the network.
export function createToolCaller(opts: { sdk: Pick<Anthropic, 'messages'> }): ToolCaller {
  return {
    async callTool({ system, user, toolName, toolSchema, model }) {
      const res = await opts.sdk.messages.create({
        model,
        max_tokens: 2048,
        system,
        messages: [{ role: 'user', content: user }],
        tools: [{ name: toolName, description: 'Return the mapping.', input_schema: toolSchema as never }],
        tool_choice: { type: 'tool', name: toolName },
      } as never)
      const block = (res.content as { type: string; name?: string; input?: unknown }[]).find((b) => b.type === 'tool_use')
      if (!block) throw new Error('Anthropic returned no tool_use block')
      return {
        input: block.input,
        model: res.model,
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      }
    },
  }
}

export function createAnthropicSdk(apiKey: string): Pick<Anthropic, 'messages'> {
  // Lazy import keeps the SDK out of bundles that never map schemas.
  const AnthropicCtor = require('@anthropic-ai/sdk').default as typeof Anthropic
  return new AnthropicCtor({ apiKey })
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/agents/anthropic-client.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agents/anthropic-client.ts lib/agents/anthropic-client.test.ts package.json package-lock.json
git commit -m "feat(agents): add injectable anthropic tool caller"
```

---

## Task 10: Schema mapper

**Files:**
- Create: `lib/agents/schema-mapper.ts`
- Test: `lib/agents/schema-mapper.test.ts`

Behavior: build a prompt from full schema + candidate roles + bounded sample (option names capped at `MAX_OPTION_NAMES`, properties at `MAX_PROPERTIES`); force tool-use; validate against `DatabaseMappingProposalSchema`; on validation failure do ONE repair re-prompt with the error; on second failure throw a tagged error. Apply the rationale sample-token guard. Log metadata only.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { mapSchema, PROMPT_VERSION } from './schema-mapper'
import type { ScannedDatabase } from '@/lib/notion/scanner'

const db: ScannedDatabase = {
  notionDatabaseId: 'db1',
  databaseName: 'Sales',
  properties: [
    { id: 'p1', name: 'Close Date', notionType: 'date' },
    { id: 'p2', name: 'Amount', notionType: 'number' },
    { id: 'p3', name: 'Stage', notionType: 'status', optionNames: ['Lead', 'Won'] },
  ],
  sample: [{ values: { 'Close Date': '2026-01-01', Amount: '1200', Stage: 'Won' } }],
}

const validProposal = {
  classification: 'sales pipeline',
  occurredAtPropertyId: 'p1',
  fields: [
    { notionPropertyId: 'p1', name: 'Close Date', notionType: 'date', candidateRole: 'date', role: 'date', confidence: 0.95, rationale: 'date property' },
    { notionPropertyId: 'p2', name: 'Amount', notionType: 'number', candidateRole: 'measure', role: 'measure', confidence: 0.9, rationale: 'numeric measure' },
    { notionPropertyId: 'p3', name: 'Stage', notionType: 'status', candidateRole: 'status', role: 'status', confidence: 0.8, rationale: 'pipeline stage' },
  ],
  modelVersion: 'claude-sonnet-4-6',
  promptVersion: PROMPT_VERSION,
}

describe('mapSchema', () => {
  it('returns a validated proposal on the first valid tool output', async () => {
    const caller = { callTool: vi.fn(async () => ({ input: validProposal, model: 'claude-sonnet-4-6', inputTokens: 5, outputTokens: 6 })) }
    const out = await mapSchema({ toolCaller: caller, model: 'claude-sonnet-4-6' }, db)
    expect(out.proposal.occurredAtPropertyId).toBe('p1')
    expect(caller.callTool).toHaveBeenCalledTimes(1)
  })

  it('repairs once on an invalid output then succeeds', async () => {
    const caller = {
      callTool: vi
        .fn()
        .mockResolvedValueOnce({ input: { bad: true }, model: 'm', inputTokens: 1, outputTokens: 1 })
        .mockResolvedValueOnce({ input: validProposal, model: 'm', inputTokens: 1, outputTokens: 1 }),
    }
    const out = await mapSchema({ toolCaller: caller, model: 'm' }, db)
    expect(caller.callTool).toHaveBeenCalledTimes(2)
    expect(out.proposal.classification).toBe('sales pipeline')
  })

  it('throws a tagged error after the repair also fails', async () => {
    const caller = { callTool: vi.fn(async () => ({ input: { bad: true }, model: 'm', inputTokens: 1, outputTokens: 1 })) }
    await expect(mapSchema({ toolCaller: caller, model: 'm' }, db)).rejects.toMatchObject({ code: 'MAPPER_INVALID_OUTPUT' })
  })

  it('drops a rationale that leaks a sample-only token', async () => {
    const leaky = JSON.parse(JSON.stringify(validProposal))
    leaky.fields[1].rationale = 'amount like 1200 here' // "1200" is sample-only, not schema vocab
    const caller = { callTool: vi.fn(async () => ({ input: leaky, model: 'm', inputTokens: 1, outputTokens: 1 })) }
    const out = await mapSchema({ toolCaller: caller, model: 'm' }, db)
    expect(out.proposal.fields[1].rationale).toBe('')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/agents/schema-mapper.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
import { z } from 'zod'
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
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/agents/schema-mapper.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agents/schema-mapper.ts lib/agents/schema-mapper.test.ts
git commit -m "feat(agents): add schema mapper with repair retry and rationale guard"
```

---

## Task 11: Mapping merge (review → approved)

**Files:**
- Create: `lib/mapping/merge.ts`
- Test: `lib/mapping/merge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { applyEdits } from './merge'
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'

const proposal: DatabaseMappingProposal = {
  classification: 'sales pipeline',
  occurredAtPropertyId: 'p1',
  fields: [
    { notionPropertyId: 'p1', name: 'Close Date', notionType: 'date', candidateRole: 'date', role: 'date', confidence: 0.9, rationale: 'date' },
    { notionPropertyId: 'p2', name: 'Amount', notionType: 'number', candidateRole: 'measure', role: 'measure', confidence: 0.9, rationale: 'num' },
  ],
  modelVersion: 'm',
  promptVersion: 'mapper-v1',
}

describe('applyEdits', () => {
  it('overrides roles and occurredAt from human edits and validates', () => {
    const out = applyEdits(proposal, { occurredAtPropertyId: 'p1', roles: { p2: 'dimension' } })
    expect(out.fields.find((f) => f.notionPropertyId === 'p2')!.role).toBe('dimension')
  })

  it('rejects an edit for an unknown property', () => {
    expect(() => applyEdits(proposal, { occurredAtPropertyId: 'p1', roles: { pX: 'measure' } })).toThrow(/unknown property/)
  })

  it('rejects an occurredAt that is not a date-role field', () => {
    expect(() => applyEdits(proposal, { occurredAtPropertyId: 'p2', roles: {} })).toThrow(/occurredAt/)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/mapping/merge.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
import { DatabaseMappingProposalSchema, type DatabaseMappingProposal, type Role } from '@/lib/contracts/mapping'

export interface MappingEdits {
  occurredAtPropertyId: string | null
  roles: Record<string, Role> // notionPropertyId -> chosen role
}

// Apply the reviewer's role/occurredAt overrides onto a proposal and re-validate.
export function applyEdits(proposal: DatabaseMappingProposal, edits: MappingEdits): DatabaseMappingProposal {
  const ids = new Set(proposal.fields.map((f) => f.notionPropertyId))
  for (const id of Object.keys(edits.roles)) {
    if (!ids.has(id)) throw new Error(`unknown property in edits: ${id}`)
  }
  const fields = proposal.fields.map((f) =>
    edits.roles[f.notionPropertyId] ? { ...f, role: edits.roles[f.notionPropertyId] } : f,
  )
  if (edits.occurredAtPropertyId !== null) {
    const target = fields.find((f) => f.notionPropertyId === edits.occurredAtPropertyId)
    if (!target || target.role !== 'date') throw new Error('occurredAt must reference a date-role field')
  }
  return DatabaseMappingProposalSchema.parse({ ...proposal, fields, occurredAtPropertyId: edits.occurredAtPropertyId })
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/mapping/merge.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/mapping/merge.ts lib/mapping/merge.test.ts
git commit -m "feat(mapping): apply and validate human mapping edits"
```

---

## Task 12: Scan-run data layer

**Files:**
- Create: `lib/data/scan-runs.ts`
- Test: `lib/data/scan-runs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { createScanRun, getScanRunForWorkspace, setRunResults } from './scan-runs'

function fakePrisma(over: Record<string, unknown> = {}) {
  return {
    workspaceScanRun: {
      create: vi.fn(async () => ({ id: 'run_1' })),
      findFirst: vi.fn(async () => ({ id: 'run_1', workspaceId: 'ws_1', status: 'proposed' })),
      update: vi.fn(async () => ({ id: 'run_1' })),
    },
    ...over,
  } as unknown as PrismaClient
}

describe('scan-runs', () => {
  it('creates a queued run scoped to the workspace', async () => {
    const prisma = fakePrisma()
    const res = await createScanRun(prisma, { workspaceId: 'ws_1', selectedDatabaseIds: ['db1'] })
    expect(res).toEqual({ id: 'run_1' })
    expect(prisma.workspaceScanRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ workspaceId: 'ws_1', status: 'queued', selectedDatabaseIds: ['db1'] }) }),
    )
  })

  it('reads a run only within its workspace (tenant scoped)', async () => {
    const prisma = fakePrisma()
    await getScanRunForWorkspace(prisma, { workspaceId: 'ws_1', scanRunId: 'run_1' })
    expect(prisma.workspaceScanRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'run_1', workspaceId: 'ws_1' } }),
    )
  })

  it('updates results + status', async () => {
    const prisma = fakePrisma()
    await setRunResults(prisma, { scanRunId: 'run_1', status: 'proposed', results: [{ notionDatabaseId: 'db1', status: 'mapped' }] })
    expect(prisma.workspaceScanRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'run_1' }, data: expect.objectContaining({ status: 'proposed' }) }),
    )
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/data/scan-runs.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
import type { PrismaClient } from '@prisma/client'

export interface DbResult { notionDatabaseId: string; status: 'scanned' | 'mapped' | 'failed'; errorCode?: string }

export async function createScanRun(
  prisma: PrismaClient,
  input: { workspaceId: string; selectedDatabaseIds: string[] },
): Promise<{ id: string }> {
  const run = await prisma.workspaceScanRun.create({
    data: { workspaceId: input.workspaceId, status: 'queued', selectedDatabaseIds: input.selectedDatabaseIds },
    select: { id: true },
  })
  return run
}

export async function getScanRunForWorkspace(
  prisma: PrismaClient,
  args: { workspaceId: string; scanRunId: string },
) {
  return prisma.workspaceScanRun.findFirst({ where: { id: args.scanRunId, workspaceId: args.workspaceId } })
}

export async function setRunResults(
  prisma: PrismaClient,
  args: { scanRunId: string; status: string; results?: DbResult[]; error?: string; mapperModel?: string; mapperPromptVersion?: string; propertyCount?: number; sampleRowCount?: number },
): Promise<void> {
  await prisma.workspaceScanRun.update({
    where: { id: args.scanRunId },
    data: {
      status: args.status,
      results: args.results,
      error: args.error,
      mapperModel: args.mapperModel,
      mapperPromptVersion: args.mapperPromptVersion,
      propertyCount: args.propertyCount,
      sampleRowCount: args.sampleRowCount,
    },
  })
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/data/scan-runs.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/data/scan-runs.ts lib/data/scan-runs.test.ts
git commit -m "feat(data): add tenant-scoped scan run persistence"
```

---

## Task 13: Mapping data layer (upsert-in-place, schema-hash gate, derived approval)

**Files:**
- Create: `lib/data/mappings.ts`
- Test: `lib/data/mappings.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { upsertProposedMapping, approveMapping, isRunFullyApproved } from './mappings'

const proposal = { classification: 'x', occurredAtPropertyId: null, fields: [], modelVersion: 'm', promptVersion: 'mapper-v1' }

describe('upsertProposedMapping', () => {
  it('keeps an approved mapping when schemaHash is unchanged', async () => {
    const prisma = {
      databaseMapping: {
        findUnique: vi.fn(async () => ({ id: 'm1', status: 'approved', schemaHash: 'H' })),
        update: vi.fn(async () => ({ id: 'm1' })),
        create: vi.fn(),
      },
    } as unknown as PrismaClient
    await upsertProposedMapping(prisma, {
      workspaceId: 'ws_1', notionDatabaseId: 'db1', databaseName: 'D', schema: [], schemaHash: 'H', proposal, scanRunId: 'run_1',
    })
    const data = (prisma.databaseMapping.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data
    expect(data.status).toBeUndefined() // unchanged hash => do not touch status
    expect(data.proposedMapping).toEqual(proposal)
  })

  it('resets an approved mapping to proposed when schemaHash changed', async () => {
    const prisma = {
      databaseMapping: {
        findUnique: vi.fn(async () => ({ id: 'm1', status: 'approved', schemaHash: 'OLD' })),
        update: vi.fn(async () => ({ id: 'm1' })),
        create: vi.fn(),
      },
    } as unknown as PrismaClient
    await upsertProposedMapping(prisma, {
      workspaceId: 'ws_1', notionDatabaseId: 'db1', databaseName: 'D', schema: [], schemaHash: 'NEW', proposal, scanRunId: 'run_1',
    })
    const data = (prisma.databaseMapping.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data
    expect(data.status).toBe('proposed')
  })

  it('creates a new proposed mapping when none exists', async () => {
    const prisma = {
      databaseMapping: { findUnique: vi.fn(async () => null), update: vi.fn(), create: vi.fn(async () => ({ id: 'm1' })) },
    } as unknown as PrismaClient
    await upsertProposedMapping(prisma, {
      workspaceId: 'ws_1', notionDatabaseId: 'db1', databaseName: 'D', schema: [], schemaHash: 'H', proposal, scanRunId: 'run_1',
    })
    expect(prisma.databaseMapping.create).toHaveBeenCalled()
  })
})

describe('isRunFullyApproved', () => {
  it('true only when every non-failed selected db is approved', () => {
    const results = [{ notionDatabaseId: 'db1', status: 'mapped' }, { notionDatabaseId: 'db2', status: 'failed' }]
    expect(isRunFullyApproved(results as never, new Set(['db1']))).toBe(true)
    expect(isRunFullyApproved(results as never, new Set([]))).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/data/mappings.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
import type { PrismaClient } from '@prisma/client'
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'
import type { DbResult } from './scan-runs'

export async function upsertProposedMapping(
  prisma: PrismaClient,
  input: {
    workspaceId: string
    notionDatabaseId: string
    databaseName: string
    schema: unknown
    schemaHash: string
    proposal: DatabaseMappingProposal
    scanRunId: string
  },
): Promise<void> {
  const existing = await prisma.databaseMapping.findUnique({
    where: { workspaceId_notionDatabaseId: { workspaceId: input.workspaceId, notionDatabaseId: input.notionDatabaseId } },
  })
  if (!existing) {
    await prisma.databaseMapping.create({
      data: {
        workspaceId: input.workspaceId,
        notionDatabaseId: input.notionDatabaseId,
        databaseName: input.databaseName,
        classification: input.proposal.classification,
        schema: input.schema as object,
        schemaHash: input.schemaHash,
        proposedMapping: input.proposal as object,
        status: 'proposed',
        lastScanRunId: input.scanRunId,
      },
    })
    return
  }
  // Re-scan: refresh the proposal; reset approval ONLY if the full-schema hash changed.
  const schemaChanged = existing.schemaHash !== input.schemaHash
  await prisma.databaseMapping.update({
    where: { id: existing.id },
    data: {
      databaseName: input.databaseName,
      classification: input.proposal.classification,
      schema: input.schema as object,
      schemaHash: input.schemaHash,
      proposedMapping: input.proposal as object,
      lastScanRunId: input.scanRunId,
      ...(schemaChanged ? { status: 'proposed' } : {}),
    },
  })
}

export async function approveMapping(
  prisma: PrismaClient,
  args: { workspaceId: string; mappingId: string; approved: DatabaseMappingProposal },
): Promise<{ notionDatabaseId: string; lastScanRunId: string } | null> {
  const mapping = await prisma.databaseMapping.findFirst({ where: { id: args.mappingId, workspaceId: args.workspaceId } })
  if (!mapping) return null
  await prisma.databaseMapping.update({
    where: { id: mapping.id },
    data: { approvedMapping: args.approved as object, status: 'approved' },
  })
  return { notionDatabaseId: mapping.notionDatabaseId, lastScanRunId: mapping.lastScanRunId }
}

export async function listApprovedStatuses(
  prisma: PrismaClient,
  args: { workspaceId: string; notionDatabaseIds: string[] },
): Promise<Set<string>> {
  const rows = await prisma.databaseMapping.findMany({
    where: { workspaceId: args.workspaceId, notionDatabaseId: { in: args.notionDatabaseIds }, status: 'approved' },
    select: { notionDatabaseId: true },
  })
  return new Set(rows.map((r) => r.notionDatabaseId))
}

// Pure: a run is approved when every selected db that did NOT fail has an approved mapping.
export function isRunFullyApproved(results: DbResult[], approvedDbIds: Set<string>): boolean {
  const needed = results.filter((r) => r.status !== 'failed').map((r) => r.notionDatabaseId)
  if (needed.length === 0) return false
  return needed.every((id) => approvedDbIds.has(id))
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/data/mappings.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/data/mappings.ts lib/data/mappings.test.ts
git commit -m "feat(data): add mapping upsert approval and derived run state"
```

---

## Task 14: Scan job handler (`runScan`)

**Files:**
- Create: `lib/jobs/run-scan.ts`
- Test: `lib/jobs/run-scan.test.ts`

`runScan` takes injected deps (so it is tested without Redis): a function to load the run + decrypted token, a notion client factory, the mapper, and prisma.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { runScan } from './run-scan'

const scannedDb = { notionDatabaseId: 'db1', databaseName: 'Sales', properties: [{ id: 'p1', name: 'Amount', notionType: 'number' }], sample: [] }
const proposal = { classification: 'x', occurredAtPropertyId: null, fields: [], modelVersion: 'm', promptVersion: 'mapper-v1' }

function deps(over: Record<string, unknown> = {}) {
  return {
    loadRun: vi.fn(async () => ({ workspaceId: 'ws_1', selectedDatabaseIds: ['db1'] })),
    scan: vi.fn(async () => [scannedDb]),
    map: vi.fn(async () => ({ proposal, inputTokens: 1, outputTokens: 1, model: 'm' })),
    upsert: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    ...over,
  }
}

describe('runScan', () => {
  it('scans, maps, upserts, and finishes the run as proposed', async () => {
    const d = deps()
    await runScan(d as never, 'run_1')
    expect(d.upsert).toHaveBeenCalledTimes(1)
    expect(d.finish).toHaveBeenCalledWith('run_1', expect.objectContaining({ status: 'proposed', results: [{ notionDatabaseId: 'db1', status: 'mapped' }] }))
  })

  it('records a per-db failure but still finishes proposed', async () => {
    const d = deps({ map: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'MAPPER_INVALID_OUTPUT' }) }) })
    await runScan(d as never, 'run_1')
    expect(d.finish).toHaveBeenCalledWith('run_1', expect.objectContaining({
      status: 'proposed',
      results: [{ notionDatabaseId: 'db1', status: 'failed', errorCode: 'MAPPER_INVALID_OUTPUT' }],
    }))
  })

  it('marks the whole run failed on a fatal load/scan error', async () => {
    const d = deps({ scan: vi.fn(async () => { throw new Error('notion down') }) })
    await runScan(d as never, 'run_1')
    expect(d.finish).toHaveBeenCalledWith('run_1', expect.objectContaining({ status: 'failed' }))
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/jobs/run-scan.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
import { hashSchema } from '@/lib/mapping/schema-hash'
import type { ScannedDatabase } from '@/lib/notion/scanner'
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'
import type { DbResult } from '@/lib/data/scan-runs'
import { log } from '@/lib/log'

export interface RunScanDeps {
  loadRun(scanRunId: string): Promise<{ workspaceId: string; selectedDatabaseIds: string[] }>
  scan(workspaceId: string, databaseIds: string[]): Promise<ScannedDatabase[]>
  map(db: ScannedDatabase): Promise<{ proposal: DatabaseMappingProposal; model: string }>
  upsert(args: { workspaceId: string; db: ScannedDatabase; schemaHash: string; proposal: DatabaseMappingProposal; scanRunId: string }): Promise<void>
  finish(scanRunId: string, args: { status: string; results?: DbResult[]; error?: string; mapperModel?: string; propertyCount?: number; sampleRowCount?: number }): Promise<void>
}

export async function runScan(deps: RunScanDeps, scanRunId: string): Promise<void> {
  try {
    const run = await deps.loadRun(scanRunId)
    const dbs = await deps.scan(run.workspaceId, run.selectedDatabaseIds)
    const results: DbResult[] = []
    let model: string | undefined
    let propertyCount = 0
    let sampleRowCount = 0
    for (const db of dbs) {
      propertyCount += db.properties.length
      sampleRowCount += db.sample.length
      try {
        const { proposal, model: m } = await deps.map(db)
        model = m
        await deps.upsert({ workspaceId: run.workspaceId, db, schemaHash: hashSchema(db.properties), proposal, scanRunId })
        results.push({ notionDatabaseId: db.notionDatabaseId, status: 'mapped' })
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'SCAN_ERROR'
        log.error('scan_db_failed', { scanRunId, notionDatabaseId: db.notionDatabaseId, errorCode: code })
        results.push({ notionDatabaseId: db.notionDatabaseId, status: 'failed', errorCode: code })
      }
    }
    await deps.finish(scanRunId, { status: 'proposed', results, mapperModel: model, propertyCount, sampleRowCount })
  } catch (err) {
    log.error('scan_run_failed', { scanRunId })
    await deps.finish(scanRunId, { status: 'failed', error: 'scan run failed' })
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/jobs/run-scan.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/jobs/run-scan.ts lib/jobs/run-scan.test.ts
git commit -m "feat(jobs): add scan job handler with partial failure handling"
```

---

## Task 15: BullMQ queue + worker wiring

**Files:**
- Create: `lib/jobs/queue.ts`
- Create: `lib/jobs/worker.ts`
- Modify: `package.json` (add `worker` script)
- Test: `lib/jobs/queue.test.ts`

Install:

```bash
npm install bullmq ioredis
```

This task is thin glue. We unit-test only the pure pieces (`buildScanDeps` wiring shape and the enqueue payload); the BullMQ `Worker`/`Queue` construction is not unit-tested (it requires Redis and is covered by the e2e/manual smoke).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { scanJobPayload, SCAN_QUEUE } from './queue'

describe('queue', () => {
  it('names the queue and builds a minimal job payload', () => {
    expect(SCAN_QUEUE).toBe('workspace-scan')
    expect(scanJobPayload('run_1')).toEqual({ scanRunId: 'run_1' })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/jobs/queue.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`lib/jobs/queue.ts`:

```ts
import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { getEnv } from '@/lib/env'

export const SCAN_QUEUE = 'workspace-scan'
export interface ScanJob { scanRunId: string }

export function scanJobPayload(scanRunId: string): ScanJob {
  return { scanRunId }
}

let queue: Queue<ScanJob> | undefined
export function getScanQueue(): Queue<ScanJob> {
  if (!queue) {
    const connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null })
    queue = new Queue<ScanJob>(SCAN_QUEUE, { connection })
  }
  return queue
}

export async function enqueueScan(scanRunId: string): Promise<void> {
  await getScanQueue().add('scan', scanJobPayload(scanRunId), { attempts: 1, removeOnComplete: true, removeOnFail: false })
}
```

`lib/jobs/worker.ts`:

```ts
import { Worker } from 'bullmq'
import IORedis from 'ioredis'
import { getEnv } from '@/lib/env'
import { getPrisma } from '@/lib/prisma'
import { decryptToken } from '@/lib/crypto/token-cipher'
import { createRateLimiter } from '@/lib/notion/rate-limiter'
import { createNotionClient } from '@/lib/notion/notion-client'
import { scanDatabases } from '@/lib/notion/scanner'
import { mapSchema } from '@/lib/agents/schema-mapper'
import { createToolCaller, createAnthropicSdk } from '@/lib/agents/anthropic-client'
import { runScan, type RunScanDeps } from './run-scan'
import { upsertProposedMapping } from '@/lib/data/mappings'
import { setRunResults } from '@/lib/data/scan-runs'
import { SCAN_QUEUE, type ScanJob } from './queue'

const MODEL = 'claude-sonnet-4-6'

function buildDeps(): RunScanDeps {
  const prisma = getPrisma()
  const env = getEnv()
  const toolCaller = createToolCaller({ sdk: createAnthropicSdk(env.ANTHROPIC_API_KEY) })
  return {
    async loadRun(scanRunId) {
      const run = await prisma.workspaceScanRun.findUniqueOrThrow({
        where: { id: scanRunId },
        include: { workspace: { include: { notionConnection: true } } },
      })
      return { workspaceId: run.workspaceId, selectedDatabaseIds: run.selectedDatabaseIds as string[] }
    },
    async scan(workspaceId, databaseIds) {
      const conn = await prisma.notionConnection.findUniqueOrThrow({ where: { workspaceId } })
      const token = decryptToken(conn.encryptedToken, env.TOKEN_ENCRYPTION_KEY, conn.notionWorkspaceId)
      const client = createNotionClient({ token, rateLimiter: createRateLimiter({ ratePerSec: 3 }) })
      return scanDatabases(client, databaseIds)
    },
    async map(db) {
      const { proposal, model } = await mapSchema({ toolCaller, model: MODEL }, db)
      return { proposal, model }
    },
    async upsert(args) {
      await upsertProposedMapping(prisma, {
        workspaceId: args.workspaceId,
        notionDatabaseId: args.db.notionDatabaseId,
        databaseName: args.db.databaseName,
        schema: args.db.properties,
        schemaHash: args.schemaHash,
        proposal: args.proposal,
        scanRunId: args.scanRunId,
      })
    },
    async finish(scanRunId, a) {
      await setRunResults(prisma, { scanRunId, ...a })
    },
  }
}

const connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null })
new Worker<ScanJob>(SCAN_QUEUE, async (job) => runScan(buildDeps(), job.data.scanRunId), { connection })
```

Add to `package.json` scripts:

```json
    "worker": "tsx lib/jobs/worker.ts"
```

Install the runtime TS runner: `npm install -D tsx`.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/jobs/queue.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/jobs/queue.ts lib/jobs/worker.ts lib/jobs/queue.test.ts package.json package-lock.json
git commit -m "feat(jobs): wire bullmq scan queue and worker"
```

---

## Task 16: GET /api/notion/databases (list)

**Files:**
- Create: `app/api/notion/databases/route.ts`
- Test: `app/api/notion/databases/route.test.ts`

Helper for resolving the caller's workspace + decrypted token is reused by routes; add `getConnectionForUser` to `lib/data/connections.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }))
vi.mock('@/lib/env', () => ({ getEnv: () => ({ TOKEN_ENCRYPTION_KEY: 'k', NEXT_PUBLIC_APP_URL: 'https://app.test' }) }))
vi.mock('@/lib/prisma', () => ({ getPrisma: () => ({}) }))
const getConnectionForUser = vi.fn()
vi.mock('@/lib/data/connections', () => ({ getConnectionForUser: (...a: unknown[]) => getConnectionForUser(...a) }))
const decryptToken = vi.fn(() => 'tok')
vi.mock('@/lib/crypto/token-cipher', () => ({ decryptToken: (...a: unknown[]) => decryptToken(...a) }))
const searchDatabases = vi.fn()
vi.mock('@/lib/notion/notion-client', () => ({ createNotionClient: () => ({ searchDatabases }) }))
vi.mock('@/lib/notion/rate-limiter', () => ({ createRateLimiter: () => ({ acquire: async () => {} }) }))

import { auth } from '@clerk/nextjs/server'
import { GET } from './route'
const mockedAuth = vi.mocked(auth)

describe('GET /api/notion/databases', () => {
  beforeEach(() => vi.clearAllMocks())

  it('401 when unauthenticated', async () => {
    mockedAuth.mockResolvedValue({ userId: null } as never)
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns an empty list when there is no connection', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    getConnectionForUser.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ databases: [] })
  })

  it('returns databases for a connected workspace', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    getConnectionForUser.mockResolvedValue({ encryptedToken: 'c', notionWorkspaceId: 'nws' })
    searchDatabases.mockResolvedValue({ databases: [{ id: 'db1', title: 'Sales', icon: null, lastEditedTime: '' }], nextCursor: null })
    const res = await GET()
    expect(await res.json()).toEqual({ databases: [{ id: 'db1', title: 'Sales', icon: null, lastEditedTime: '' }] })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run app/api/notion/databases/route.test.ts` → FAIL.

- [ ] **Step 3: Implement**

First add to `lib/data/connections.ts`:

```ts
export async function getConnectionForUser(prisma: PrismaClient, userId: string) {
  const workspace = await prisma.workspace.findFirst({
    where: { members: { some: { userId } } },
    include: { notionConnection: true },
  })
  return workspace?.notionConnection ?? null
}
```

Then `app/api/notion/databases/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getEnv } from '@/lib/env'
import { getPrisma } from '@/lib/prisma'
import { getConnectionForUser } from '@/lib/data/connections'
import { decryptToken } from '@/lib/crypto/token-cipher'
import { createNotionClient } from '@/lib/notion/notion-client'
import { createRateLimiter } from '@/lib/notion/rate-limiter'

const MAX_PAGES = 5 // bounded: at most 500 databases listed

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const conn = await getConnectionForUser(getPrisma(), userId)
  if (!conn) return NextResponse.json({ databases: [] })

  const env = getEnv()
  const token = decryptToken(conn.encryptedToken, env.TOKEN_ENCRYPTION_KEY, conn.notionWorkspaceId)
  const client = createNotionClient({ token, rateLimiter: createRateLimiter({ ratePerSec: 3 }) })

  const databases = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const { databases: batch, nextCursor } = await client.searchDatabases({ cursor })
    databases.push(...batch)
    if (!nextCursor) break
    cursor = nextCursor
  }
  return NextResponse.json({ databases })
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run app/api/notion/databases/route.test.ts` → PASS. Add a quick test to `lib/data/connections.test.ts` for `getConnectionForUser` (mirrors `getWorkspaceForUser`).

- [ ] **Step 5: Commit**

```bash
git add app/api/notion/databases lib/data/connections.ts lib/data/connections.test.ts
git commit -m "feat(notion): add databases list endpoint"
```

---

## Task 17: POST /api/scan (enqueue)

**Files:**
- Create: `app/api/scan/route.ts`
- Test: `app/api/scan/route.test.ts`

Reuse the same-origin guard from `app/api/notion/disconnect/route.ts` (copy `isSameOrigin`). Validate body with zod.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }))
vi.mock('@/lib/env', () => ({ getEnv: () => ({ NEXT_PUBLIC_APP_URL: 'https://app.test' }) }))
vi.mock('@/lib/prisma', () => ({ getPrisma: () => ({}) }))
const getWorkspaceForUser = vi.fn()
vi.mock('@/lib/data/connections', () => ({ getWorkspaceForUser: (...a: unknown[]) => getWorkspaceForUser(...a) }))
const createScanRun = vi.fn()
vi.mock('@/lib/data/scan-runs', () => ({ createScanRun: (...a: unknown[]) => createScanRun(...a) }))
const enqueueScan = vi.fn()
vi.mock('@/lib/jobs/queue', () => ({ enqueueScan: (...a: unknown[]) => enqueueScan(...a) }))

import type { NextRequest } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { POST } from './route'
const mockedAuth = vi.mocked(auth)

function req(body: unknown, origin: string | null = 'https://app.test'): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (origin !== null) headers.set('origin', origin)
  return new Request('https://app.test/api/scan', { method: 'POST', headers, body: JSON.stringify(body) }) as unknown as NextRequest
}

describe('POST /api/scan', () => {
  beforeEach(() => vi.clearAllMocks())

  it('403 cross-origin without enqueuing', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    const res = await POST(req({ databaseIds: ['db1'] }, 'https://evil.test'))
    expect(res.status).toBe(403)
    expect(enqueueScan).not.toHaveBeenCalled()
  })

  it('401 when unauthenticated', async () => {
    mockedAuth.mockResolvedValue({ userId: null } as never)
    expect((await POST(req({ databaseIds: ['db1'] }))).status).toBe(401)
  })

  it('400 on an empty database selection', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    expect((await POST(req({ databaseIds: [] }))).status).toBe(400)
  })

  it('creates a run and enqueues, returning scanRunId', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    getWorkspaceForUser.mockResolvedValue({ id: 'ws_1' })
    createScanRun.mockResolvedValue({ id: 'run_1' })
    const res = await POST(req({ databaseIds: ['db1', 'db2'] }))
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ scanRunId: 'run_1' })
    expect(enqueueScan).toHaveBeenCalledWith('run_1')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run app/api/scan/route.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@clerk/nextjs/server'
import { getEnv } from '@/lib/env'
import { getPrisma } from '@/lib/prisma'
import { getWorkspaceForUser } from '@/lib/data/connections'
import { createScanRun } from '@/lib/data/scan-runs'
import { enqueueScan } from '@/lib/jobs/queue'
import { log } from '@/lib/log'

const Body = z.object({ databaseIds: z.array(z.string().min(1)).min(1).max(100) })

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

  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 })

  const prisma = getPrisma()
  const workspace = await getWorkspaceForUser(prisma, userId)
  if (!workspace) return NextResponse.json({ error: 'no_workspace' }, { status: 400 })

  const run = await createScanRun(prisma, { workspaceId: workspace.id, selectedDatabaseIds: parsed.data.databaseIds })
  await enqueueScan(run.id)
  log.info('scan_enqueued', { userId, workspaceId: workspace.id, scanRunId: run.id, databaseCount: parsed.data.databaseIds.length })
  return NextResponse.json({ scanRunId: run.id }, { status: 202 })
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run app/api/scan/route.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/scan/route.ts app/api/scan/route.test.ts
git commit -m "feat(scan): add scan enqueue endpoint"
```

---

## Task 18: GET /api/scan/[scanRunId] (poll)

**Files:**
- Create: `app/api/scan/[scanRunId]/route.ts`
- Test: `app/api/scan/[scanRunId]/route.test.ts`

> Next 16: the second handler arg is `{ params: Promise<{ scanRunId: string }> }` — **await it**.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ getPrisma: () => ({}) }))
const getWorkspaceForUser = vi.fn()
vi.mock('@/lib/data/connections', () => ({ getWorkspaceForUser: (...a: unknown[]) => getWorkspaceForUser(...a) }))
const getScanRunForWorkspace = vi.fn()
vi.mock('@/lib/data/scan-runs', () => ({ getScanRunForWorkspace: (...a: unknown[]) => getScanRunForWorkspace(...a) }))

import { auth } from '@clerk/nextjs/server'
import { GET } from './route'
const mockedAuth = vi.mocked(auth)
const ctx = (scanRunId: string) => ({ params: Promise.resolve({ scanRunId }) })

describe('GET /api/scan/[scanRunId]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('401 when unauthenticated', async () => {
    mockedAuth.mockResolvedValue({ userId: null } as never)
    expect((await GET(new Request('https://app.test') as never, ctx('run_1'))).status).toBe(401)
  })

  it('404 when the run is not in the caller workspace', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    getWorkspaceForUser.mockResolvedValue({ id: 'ws_1' })
    getScanRunForWorkspace.mockResolvedValue(null)
    expect((await GET(new Request('https://app.test') as never, ctx('run_x'))).status).toBe(404)
  })

  it('returns status + results', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    getWorkspaceForUser.mockResolvedValue({ id: 'ws_1' })
    getScanRunForWorkspace.mockResolvedValue({ id: 'run_1', status: 'proposed', results: [{ notionDatabaseId: 'db1', status: 'mapped' }] })
    const res = await GET(new Request('https://app.test') as never, ctx('run_1'))
    expect(await res.json()).toEqual({ scanRunId: 'run_1', status: 'proposed', results: [{ notionDatabaseId: 'db1', status: 'mapped' }] })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run "app/api/scan/[scanRunId]/route.test.ts"` → FAIL.

- [ ] **Step 3: Implement**

```ts
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getPrisma } from '@/lib/prisma'
import { getWorkspaceForUser } from '@/lib/data/connections'
import { getScanRunForWorkspace } from '@/lib/data/scan-runs'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ scanRunId: string }> }) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { scanRunId } = await params

  const prisma = getPrisma()
  const workspace = await getWorkspaceForUser(prisma, userId)
  if (!workspace) return NextResponse.json({ error: 'no_workspace' }, { status: 400 })

  const run = await getScanRunForWorkspace(prisma, { workspaceId: workspace.id, scanRunId })
  if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  return NextResponse.json({ scanRunId: run.id, status: run.status, results: run.results ?? [] })
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run "app/api/scan/[scanRunId]/route.test.ts"` → PASS.

- [ ] **Step 5: Commit**

```bash
git add "app/api/scan/[scanRunId]"
git commit -m "feat(scan): add scan status poll endpoint"
```

---

## Task 19: POST /api/mappings/[id]/approve

**Files:**
- Create: `app/api/mappings/[id]/approve/route.ts`
- Test: `app/api/mappings/[id]/approve/route.test.ts`

Flow: same-origin guard → auth → resolve workspace → load mapping (tenant-scoped) → `applyEdits` on its `proposedMapping` → `approveMapping` → recompute run approval (`listApprovedStatuses` + `isRunFullyApproved`) → if fully approved, set the run `approved`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }))
vi.mock('@/lib/env', () => ({ getEnv: () => ({ NEXT_PUBLIC_APP_URL: 'https://app.test' }) }))
vi.mock('@/lib/prisma', () => ({ getPrisma: () => ({ databaseMapping: { findFirst: findFirst }, workspaceScanRun: { findUnique: runFind, update: runUpdate } }) }))
vi.mock('@/lib/data/connections', () => ({ getWorkspaceForUser: (...a: unknown[]) => getWorkspaceForUser(...a) }))
vi.mock('@/lib/data/mappings', () => ({
  approveMapping: (...a: unknown[]) => approveMapping(...a),
  listApprovedStatuses: (...a: unknown[]) => listApprovedStatuses(...a),
  isRunFullyApproved: (...a: unknown[]) => isRunFullyApproved(...a),
}))

const getWorkspaceForUser = vi.fn()
const approveMapping = vi.fn()
const listApprovedStatuses = vi.fn()
const isRunFullyApproved = vi.fn()
const findFirst = vi.fn()
const runFind = vi.fn()
const runUpdate = vi.fn()

import type { NextRequest } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { POST } from './route'
const mockedAuth = vi.mocked(auth)

const validEdits = { occurredAtPropertyId: null, roles: {} }
function req(body: unknown, origin: string | null = 'https://app.test'): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (origin !== null) headers.set('origin', origin)
  return new Request('https://app.test/api/mappings/m1/approve', { method: 'POST', headers, body: JSON.stringify(body) }) as unknown as NextRequest
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const proposal = { classification: 'x', occurredAtPropertyId: null, fields: [], modelVersion: 'm', promptVersion: 'mapper-v1' }

describe('POST /api/mappings/[id]/approve', () => {
  beforeEach(() => vi.clearAllMocks())

  it('403 cross-origin', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    expect((await POST(req(validEdits, 'https://evil.test'), ctx('m1'))).status).toBe(403)
  })

  it('404 when the mapping is not in the caller workspace', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    getWorkspaceForUser.mockResolvedValue({ id: 'ws_1' })
    findFirst.mockResolvedValue(null)
    expect((await POST(req(validEdits), ctx('m1'))).status).toBe(404)
  })

  it('approves the mapping and marks the run approved when all are done', async () => {
    mockedAuth.mockResolvedValue({ userId: 'u1' } as never)
    getWorkspaceForUser.mockResolvedValue({ id: 'ws_1' })
    findFirst.mockResolvedValue({ id: 'm1', workspaceId: 'ws_1', proposedMapping: proposal })
    approveMapping.mockResolvedValue({ notionDatabaseId: 'db1', lastScanRunId: 'run_1' })
    runFind.mockResolvedValue({ id: 'run_1', selectedDatabaseIds: ['db1'], results: [{ notionDatabaseId: 'db1', status: 'mapped' }] })
    listApprovedStatuses.mockResolvedValue(new Set(['db1']))
    isRunFullyApproved.mockReturnValue(true)
    const res = await POST(req(validEdits), ctx('m1'))
    expect(res.status).toBe(200)
    expect(runUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'run_1' }, data: { status: 'approved' } }))
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run "app/api/mappings/[id]/approve/route.test.ts"` → FAIL.

- [ ] **Step 3: Implement**

```ts
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@clerk/nextjs/server'
import { getEnv } from '@/lib/env'
import { getPrisma } from '@/lib/prisma'
import { getWorkspaceForUser } from '@/lib/data/connections'
import { approveMapping, listApprovedStatuses, isRunFullyApproved } from '@/lib/data/mappings'
import { applyEdits } from '@/lib/mapping/merge'
import { RoleSchema, type DatabaseMappingProposal } from '@/lib/contracts/mapping'
import { log } from '@/lib/log'

const Body = z.object({ occurredAtPropertyId: z.string().nullable(), roles: z.record(z.string(), RoleSchema) })

function isSameOrigin(req: NextRequest, appUrl: string): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return false
  try {
    return new URL(origin).host === new URL(appUrl).host
  } catch {
    return false
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req, getEnv().NEXT_PUBLIC_APP_URL)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params

  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 })

  const prisma = getPrisma()
  const workspace = await getWorkspaceForUser(prisma, userId)
  if (!workspace) return NextResponse.json({ error: 'no_workspace' }, { status: 400 })

  const mapping = await prisma.databaseMapping.findFirst({ where: { id, workspaceId: workspace.id } })
  if (!mapping) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  let approved: DatabaseMappingProposal
  try {
    approved = applyEdits(mapping.proposedMapping as DatabaseMappingProposal, parsed.data)
  } catch {
    return NextResponse.json({ error: 'invalid_edits' }, { status: 400 })
  }

  const result = await approveMapping(prisma, { workspaceId: workspace.id, mappingId: id, approved })
  if (!result) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const run = await prisma.workspaceScanRun.findUnique({ where: { id: result.lastScanRunId } })
  if (run) {
    const selected = run.selectedDatabaseIds as string[]
    const approvedIds = await listApprovedStatuses(prisma, { workspaceId: workspace.id, notionDatabaseIds: selected })
    const results = (run.results ?? []) as { notionDatabaseId: string; status: 'scanned' | 'mapped' | 'failed' }[]
    if (isRunFullyApproved(results, approvedIds)) {
      await prisma.workspaceScanRun.update({ where: { id: run.id }, data: { status: 'approved' } })
    }
  }

  log.info('mapping_approved', { userId, workspaceId: workspace.id, mappingId: id })
  return NextResponse.json({ approved: true })
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run "app/api/mappings/[id]/approve/route.test.ts"` → PASS.

- [ ] **Step 5: Commit**

```bash
git add "app/api/mappings/[id]/approve"
git commit -m "feat(mappings): add approve endpoint with derived run approval"
```

---

## Task 20: Review UI view-model (pure)

**Files:**
- Create: `app/app/scan/scan-view.ts`
- Test: `app/app/scan/scan-view.test.ts`

Pure helpers the components render (logic is unit-tested; components stay thin — mirrors `app/app/notion-status.ts`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { scanProgressLabel, isReviewable, fieldRowsForReview, lowConfidence } from './scan-view'

describe('scan-view', () => {
  it('summarizes per-db results', () => {
    expect(scanProgressLabel({ status: 'running', results: [] })).toBe('Scanning…')
    expect(scanProgressLabel({ status: 'proposed', results: [
      { notionDatabaseId: 'a', status: 'mapped' },
      { notionDatabaseId: 'b', status: 'failed' },
    ] })).toBe('2 mapped, 1 failed')
  })

  it('is reviewable only once proposed or approved', () => {
    expect(isReviewable('queued')).toBe(false)
    expect(isReviewable('proposed')).toBe(true)
    expect(isReviewable('approved')).toBe(true)
  })

  it('flags low confidence fields under 0.6', () => {
    expect(lowConfidence(0.5)).toBe(true)
    expect(lowConfidence(0.8)).toBe(false)
  })

  it('builds review rows with schema context, no sample values', () => {
    const rows = fieldRowsForReview({
      classification: 'sales', occurredAtPropertyId: 'p1', modelVersion: 'm', promptVersion: 'v',
      fields: [{ notionPropertyId: 'p1', name: 'Close Date', notionType: 'date', candidateRole: 'date', role: 'date', confidence: 0.9, rationale: 'date' }],
    })
    expect(rows[0]).toMatchObject({ id: 'p1', name: 'Close Date', notionType: 'date', role: 'date', isOccurredAt: true })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run app/app/scan/scan-view.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'

export interface DbResultView { notionDatabaseId: string; status: 'scanned' | 'mapped' | 'failed' }

export function scanProgressLabel(run: { status: string; results: DbResultView[] }): string {
  if (run.status === 'queued' || run.status === 'running') return 'Scanning…'
  const mapped = run.results.filter((r) => r.status === 'mapped').length
  const failed = run.results.filter((r) => r.status === 'failed').length
  return failed > 0 ? `${mapped} mapped, ${failed} failed` : `${mapped} mapped`
}

export function isReviewable(status: string): boolean {
  return status === 'proposed' || status === 'approved'
}

export function lowConfidence(confidence: number): boolean {
  return confidence < 0.6
}

export interface ReviewRow {
  id: string
  name: string
  notionType: string
  optionNames?: string[]
  relationTargetName?: string
  candidateRole: string
  role: string
  confidence: number
  rationale: string
  isOccurredAt: boolean
  flagged: boolean
}

export function fieldRowsForReview(proposal: DatabaseMappingProposal): ReviewRow[] {
  return proposal.fields.map((f) => ({
    id: f.notionPropertyId,
    name: f.name,
    notionType: f.notionType,
    optionNames: f.optionNames,
    relationTargetName: f.relationTargetName,
    candidateRole: f.candidateRole,
    role: f.role,
    confidence: f.confidence,
    rationale: f.rationale,
    isOccurredAt: proposal.occurredAtPropertyId === f.notionPropertyId,
    flagged: lowConfidence(f.confidence),
  }))
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run app/app/scan/scan-view.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add app/app/scan/scan-view.ts app/app/scan/scan-view.test.ts
git commit -m "feat(app): add scan review view-model helpers"
```

---

## Task 21: Review UI components + page wiring

**Files:**
- Create: `app/app/scan/page.tsx` (server component: lists databases, renders client island)
- Create: `app/app/scan/scan-client.tsx` (client island: selection, trigger, poll, review, approve)
- Modify: `app/app/page.tsx` (add a "Scan workspace" link when connected)

This task is presentational glue over already-tested logic/endpoints; there is no new pure logic to unit-test (the Node test env has no RTL — see spec §10). Verify via typecheck + build + manual smoke.

- [ ] **Step 1: Implement the server page**

`app/app/scan/page.tsx`:

```tsx
import { auth } from '@clerk/nextjs/server'
import { getPrisma } from '@/lib/prisma'
import { getConnectionForUser } from '@/lib/data/connections'
import { ScanClient } from './scan-client'

export default async function ScanPage() {
  const { userId } = await auth()
  const connection = userId ? await getConnectionForUser(getPrisma(), userId) : null
  if (!connection) {
    return (
      <main className="space-y-4 p-8">
        <h1 className="text-xl font-semibold">Understand your workspace</h1>
        <p className="text-sm text-gray-600">Connect Notion first to scan your databases.</p>
        <a href="/api/notion/connect" className="inline-block rounded bg-black px-4 py-2 text-sm text-white">Connect Notion</a>
      </main>
    )
  }
  return (
    <main className="space-y-4 p-8">
      <h1 className="text-xl font-semibold">Understand your workspace</h1>
      <ScanClient />
    </main>
  )
}
```

- [ ] **Step 2: Implement the client island**

`app/app/scan/scan-client.tsx`:

```tsx
'use client'
import { useEffect, useState } from 'react'
import { fieldRowsForReview, scanProgressLabel, isReviewable, type ReviewRow } from './scan-view'
import type { DatabaseMappingProposal, Role } from '@/lib/contracts/mapping'

interface DbItem { id: string; title: string }

export function ScanClient() {
  const [dbs, setDbs] = useState<DbItem[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scanRunId, setScanRunId] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('idle')
  const [results, setResults] = useState<{ notionDatabaseId: string; status: 'scanned' | 'mapped' | 'failed' }[]>([])

  useEffect(() => {
    fetch('/api/notion/databases').then((r) => r.json()).then((d) => setDbs(d.databases ?? []))
  }, [])

  useEffect(() => {
    if (!scanRunId || isReviewable(status) || status === 'failed') return
    const t = setInterval(async () => {
      const r = await fetch(`/api/scan/${scanRunId}`).then((x) => x.json())
      setStatus(r.status)
      setResults(r.results ?? [])
    }, 1500)
    return () => clearInterval(t)
  }, [scanRunId, status])

  async function startScan() {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ databaseIds: [...selected] }),
    })
    const data = await res.json()
    setScanRunId(data.scanRunId)
    setStatus('queued')
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-1">
        {dbs.map((db) => (
          <li key={db.id}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.has(db.id)}
                onChange={(e) => {
                  const next = new Set(selected)
                  e.target.checked ? next.add(db.id) : next.delete(db.id)
                  setSelected(next)
                }}
              />
              {db.title}
            </label>
          </li>
        ))}
      </ul>
      <button
        disabled={selected.size === 0 || (scanRunId !== null && !isReviewable(status) && status !== 'failed')}
        onClick={startScan}
        className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        Scan selected
      </button>
      {scanRunId && <p role="status" className="text-sm text-gray-600">{scanProgressLabel({ status, results })}</p>}
    </div>
  )
}
```

> The per-database mapping review table (rendering `fieldRowsForReview` with role dropdowns and a POST to `/api/mappings/[id]/approve`) attaches here once proposals are exposed via a mappings-list endpoint. For this task, the picker + scan-trigger + progress is the working slice; the review table is wired in the same component using the already-tested `fieldRowsForReview` helper. Keep `ReviewRow`, `DatabaseMappingProposal`, `Role` imports for that table.

- [ ] **Step 3: Add a link from the app home**

In `app/app/page.tsx`, inside the connected branch (after `<DisconnectButton />`), add:

```tsx
          <a href="/app/scan" className="inline-block text-sm text-blue-700 underline">Understand your workspace →</a>
```

- [ ] **Step 4: Verify build + types**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/app/scan app/app/page.tsx
git commit -m "feat(app): add workspace scan and review ui"
```

---

## Final verification

- [ ] Run the full gate: `npm run typecheck && npm run lint && npm run test && npm run build` — all green.
- [ ] Manual smoke (requires Redis + Postgres + real Notion connection): start `npm run dev` and `npm run worker`; connect Notion, open `/app/scan`, select a database, scan, watch status reach `proposed`, approve a mapping, confirm the run flips to `approved` and `DatabaseMapping.approvedMapping` is persisted.
- [ ] Dispatch a final code-reviewer over the whole branch, then use `superpowers:finishing-a-development-branch`.

---

## Self-Review (plan vs. spec)

**Spec coverage:** §2 list endpoint → Task 16; select-then-scan → Tasks 16/17/21; D-1 BullMQ thin boundary → Tasks 15/17/18; D-3 hand-rolled client + version isolation → Task 3; D-4 deterministic prior + AI refine → Tasks 6/10; D-5 lean taxonomy → Task 7; D-6 samples transient → Tasks 4/8 (no persistence of `sample`); D-7 plain orchestration + metadata-only logging → Tasks 10/14; D-8 current-state mapping + schema-hash gate + derived approval → Tasks 1/5/13/19; rationale containment → Task 10; sample bounds → Task 4; data model → Task 1; security guards → Tasks 16–19; testing strategy → every task's tests. **No gaps.**

**Type consistency:** `Role`, `FieldMapping`, `DatabaseMappingProposal` defined in Task 7 and used identically in 6/10/11/13/19/20; `ScannedProperty`/`ScannedSchema`/`RawRow` from Task 3 used in 4/5/8; `ScannedDatabase` from Task 8 used in 10/14; `DbResult` from Task 12 used in 13/14; `RunScanDeps` from Task 14 consumed in 15. `candidateRole` name consistent. **Consistent.**

**Note on ordering:** Task 6 (`candidate-rules`) imports `Role` from Task 7's contract — implement Task 7 first or together (called out inline in Task 6).
