# NotionIQ M3 — Truth Layer · Design Spec

**Status:** Draft — ready for plan pending user approval
**Date:** 2026-06-12
**Depends on:** M2 (Understand Workspace) — approved `DatabaseMapping` records
**Parent spec:** `docs/superpowers/specs/2026-06-05-notioniq-mvp-design.md` (§3 ADR-1/3/4, §5)

---

## 1. Summary

M3 turns approved schema mappings into a **deterministic, queryable source of typed
numbers** — the "truth layer." It adds full-row ingestion of each approved database, a
row-level `NormalizedRecord` table tagged by `snapshotVersion`, and a pure-function metric
engine. Everything in M3 is deterministic; no AI runs here. M4 (insights) and M5 (charts)
*consume* these facts.

This closes a real gap left by M2: the scanner only pulled a **bounded, stringified sample**
(`RawRow.values: Record<string,string>`) — enough to let the AI mapper classify fields, but
useless for computing real sums or counts. M3 introduces a typed, full-dataset ingestion path.

### Core principle (inherited)

> The analytics engine is the source of truth. **AI never computes numbers.** AI decides
> *which* facts to surface; the engine produces the facts. M3 is the engine.

---

## 2. Scope & boundary

**In scope (thin vertical truth layer):**

- Typed, full-row ingestion of every **approved** database (paginated, Notion backoff).
- `NormalizedRecord` (row-level truth) written at a candidate `snapshotVersion`.
- **All-or-nothing snapshot cutover** that bumps `Workspace.snapshotVersion`.
- A deterministic **metric engine**: generic aggregation primitives + a conservative named
  resolver.
- API + UI to trigger a snapshot build/refresh and poll its status.

**Out of scope (deferred):**

- Redis aggregation cache and cache keys (ADR-4) — lands in **M5** with the chart path.
- AI insight generation, the verifier, report writing — **M4**.
- Charts, filters, embed — **M5**.
- Scheduled refresh + entitlement gating — **M6** (M3 builds the manual-refresh seam M6 reuses).
- Long-term snapshot history / snapshot-over-snapshot deltas. M3 keeps **current + previous**
  only.

---

## 3. Architecture decisions

### D-1 — Ingestion is an explicit, user-triggered BullMQ job

After mappings are approved, the user clicks **"Build data snapshot."** That enqueues a
background ingest job (mirroring the M2 scan job). Snapshot building is an expensive,
rate-limited operation; decoupling it from approval keeps the heavy Notion fetch under user
control and gives M6's scheduled refresh the exact same enqueue path to call. After the first
snapshot exists, the CTA reads **"Refresh data snapshot."**

A snapshot build is user-visible, async, retryable, and must expose durable per-database
results that survive page reloads and worker restarts — so it is tracked by a **`SnapshotRun`
table**, not raw BullMQ queue state. `POST /api/snapshot` creates the `SnapshotRun` and enqueues
the job with the `snapshotRunId`; the job updates the run as it progresses; `GET /api/snapshot/[id]`
reads the `SnapshotRun`. This mirrors M2's `WorkspaceScanRun` and is the durable record M6's
scheduled refresh reuses.

### D-2 — Additive typed read path; M2's sample path is untouched

The M2 reader stringifies every cell (correct for the mapper, lossy for arithmetic). M3 adds a
**new** typed read method and a `TypedRow`/`TypedValue` contract rather than changing the
existing reader — no M2 churn, no risk to the mapping flow.

### D-3 — `NormalizedRecord` storage: promoted columns + JSONB

Hot query/filter/aggregation paths become **real indexed columns** (`workspaceId`,
`sourceDatabaseId`, `snapshotVersion`, `occurredAt`); the heterogeneous per-field values live
in one **`mappedFields` JSONB**. Rejected: per-database dynamic columns (multi-tenant DDL
nightmare) and EAV (query-hostile, row explosion). One table fits Notion's arbitrary,
per-database schemas while keeping the common query shape fast.

### D-4 — All-or-nothing snapshot cutover

Ingest **every** approved database into candidate version `N+1`. Bump
`Workspace.snapshotVersion` to `N+1` **only if all required databases succeed**. If any fails:
do **not** bump, the old snapshot (`N`) stays active, and failed databases are surfaced for
retry. A partial snapshot that silently drops a database is worse than a failed build. Orphaned
candidate rows (`version > current`) are cleaned at the start of the next ingest, so repeated
failed retries never accumulate.

### D-5 — Retain current + previous snapshot (`N` and `N-1`)

On successful cutover, prune records with `snapshotVersion < currentVersion - 1`. Keeping the
previous snapshot gives rollback and debuggability and protects against a bad refresh, while
storage stays bounded (at most two versions). This is **not** long-term history.

### D-6 — Metric engine is pure functions over a fetched record set

The engine takes an in-memory array of `NormalizedRecord`s and returns results — no DB, no
network, fully deterministic and unit-testable (spec §8). A thin workspace-scoped data-access
layer fetches the current-snapshot records and hands them to the engine. **MVP aggregates in
memory**; if M5 needs it, filtering/aggregation can later be pushed into SQL behind the same
data-access seam without changing the engine's contract.

### D-7 — Conservative, deterministic named resolver (no fuzzy guessing)

Generic primitives are always available. The named resolver (`revenue`, `profit`, `count`,
`growth`) resolves **only** when `classification` + field evidence is unambiguous; anything
ambiguous or unsupported returns an explicit `{ kind: 'unsupported', reason }`. It never guesses
business meaning. The "lone measure on a `sales`-classified DB → revenue" mapping is permitted
**only** when classification/field purpose supports it; otherwise the metric stays primitive-only.

---

## 4. Components

### Notion typed reads (`lib/notion/`)

- New contract: `TypedRow { notionPageId: string; values: Record<string, TypedValue> }` where
  `TypedValue` is a **discriminated union** on `kind` (clearer validation + normalization than a
  bare union):
  ```ts
  type TypedValue =
    | { kind: 'number'; value: number }
    | { kind: 'text';   value: string }      // select, status, title, rich_text
    | { kind: 'list';   value: string[] }    // multi_select, relation, people
    | { kind: 'date';   value: string }      // ISO 8601
    | { kind: 'empty' }                       // null/absent cell
  ```
- New client method `queryDatabaseRowsTyped(databaseId, { cursor, pageSize })` — full
  pagination through the existing rate-limiter + backoff helper, mapping native Notion types to
  `TypedValue` kinds (number→`number`, date→`date`, select/status/title→`text`,
  multi-select/relation/people→`list`, null/absent→`empty`).
- The ingest job paginates to **completion** per database (no sample bound — this is the full
  pull), respecting Notion's ~3 req/s limit.

### Normalization (`lib/normalize/`)

Pure function `normalizeRow(typedRow, approvedMapping) → NormalizedRecordInput`:

- Iterates `approvedMapping.fields`; each field's `role` routes its value into the matching
  `mappedFields` bucket. `role: 'ignore'` is dropped.
- `occurredAt` ← the value at `approvedMapping.occurredAtPropertyId`. **Invalid/unparseable
  dates leave `occurredAt = null` AND record a normalization warning** — never silently
  swallowed.
- `measure` values are coerced to `number`; an unparseable/empty measure is dropped from
  `measures` and flagged as a warning (Notion number fields can be empty).
- Deterministic; no Notion, no DB — unit-testable in isolation.

### Metric engine (`lib/metrics/`)

- `lib/metrics/primitives.ts` — `count`, `sum`, `avg`, `min`, `max`; `groupBy(dimension|status)`;
  `bucketByTime(occurredAt, 'day'|'week'|'month')`. Composable.
- `lib/metrics/named.ts` — the conservative resolver (D-7).
- All functions operate on `NormalizedRecord[]` passed in; return typed results.

### Data access (`lib/data/normalized.ts`)

- `writeSnapshotRecords(prisma, workspaceId, version, records[])` — bulk insert candidate rows.
- `commitSnapshot(prisma, workspaceId, version)` — atomic: bump `snapshotVersion` → prune
  `< version - 1`. Used only after all DBs succeed (D-4).
- `cleanOrphanCandidates(prisma, workspaceId, currentVersion)` — delete rows `> currentVersion`
  (failed prior attempt), run at ingest start.
- `getCurrentSnapshotRecords(prisma, workspaceId, { sourceDatabaseId? })` — reads
  `WHERE workspaceId AND snapshotVersion = workspace.snapshotVersion`. **Every** function is
  workspace-scoped (ADR-3); no query without `workspaceId`.

### Jobs (`lib/jobs/`)

- `runSnapshot(snapshotRunId)` job handler: load the run + approved mappings → mark run
  `running` → for each DB, typed-paginate + `normalizeRow` → `writeSnapshotRecords(N+1)`,
  updating `SnapshotRun.results` per DB → if all succeed `commitSnapshot(N+1)` and mark run
  `committed`, else leave active version untouched and mark `partial`/`failed`.
- **New, dedicated queue + worker registration.** M2's queue/worker is scan-specific
  (`SCAN_QUEUE`, `ScanJob`, `enqueueScan`, a single `Worker<ScanJob>` registered at module
  load) — there is **no generic reusable abstraction**. M3 adds its own `SNAPSHOT_QUEUE`,
  `SnapshotJob`, `enqueueSnapshot`, and a second `Worker<SnapshotJob>` registration following
  the same pattern. The plan wires this explicitly; it does not assume reuse.

### Contracts (`lib/contracts/`)

- `lib/contracts/normalized.ts` — `TypedValue`, `TypedRow`, `mappedFields` shape,
  `NormalizedRecordInput` (zod; shared API ↔ engine).
- `lib/contracts/metrics.ts` — metric request/result + the `unsupported` variant (zod; shared
  with M4/M5).

---

## 5. Data model (Prisma, additive — no destructive migration)

```prisma
model NormalizedRecord {
  id               String    @id @default(cuid())
  workspaceId      String          // tenant scope (ADR-3) — always in the WHERE
  sourceDatabaseId String          // the notionDatabaseId this row came from
  notionPageId     String          // provenance back to the Notion row
  occurredAt       DateTime?       // from approvedMapping.occurredAtPropertyId (nullable)
  snapshotVersion  Int             // the version this row belongs to
  mappedFields     Json            // typed values keyed by role + field
  createdAt        DateTime  @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, sourceDatabaseId, notionPageId, snapshotVersion]) // idempotent re-ingest
  @@index([workspaceId, snapshotVersion, sourceDatabaseId])
  @@index([workspaceId, snapshotVersion, occurredAt])
}
```

```prisma
model SnapshotRun {
  id              String    @id @default(cuid())
  workspaceId     String          // tenant scope (ADR-3)
  status          String    @default("queued") // queued | running | committed | partial | failed
  snapshotVersion Int?            // the candidate/committed version this run targeted (N+1)
  results         Json?           // per-DB: [{ sourceDatabaseId, status, rowCount?, error? }]
  error           String?         // run-level failure detail
  startedAt       DateTime?       // set when the worker begins
  finishedAt      DateTime?       // set on committed | partial | failed
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId])
}
```

`Workspace.snapshotVersion` already exists (M2 schema, default `0`). No change to its
definition; M3 starts writing it past `0`. `Workspace` gains a `snapshotRuns SnapshotRun[]`
back-relation (and `normalizedRecords NormalizedRecord[]`).

`mappedFields` JSONB shape:

```jsonc
{
  "measures":   { "<fieldId>": { "name": "Amount", "value": 1990.0 } }, // numbers stay numbers
  "dimensions": { "<fieldId>": { "name": "Region", "value": "EMEA" } },
  "status":     { "<fieldId>": { "name": "Stage",  "value": "Won"  } },
  "title":      { "value": "Acme renewal" }
}
```

---

## 6. Security (OWASP-aligned)

- **A01 Access control:** every `lib/data/normalized.ts` and `lib/data/snapshot-runs.ts`
  function is workspace-scoped; no read or write without `workspaceId`. Snapshot trigger/poll
  endpoints resolve the caller's workspace via Clerk → `WorkspaceMember`, never a client-supplied
  id; `GET /api/snapshot/[id]` verifies the run belongs to the caller's workspace before
  returning it.
- **A02 Crypto:** the Notion token is decrypted **only** server-side inside the ingest job;
  never logged, never leaves the job.
- **A03 Injection:** Prisma parameterized queries; zod-validate the snapshot endpoints.
- **A04 Insecure design:** the engine is the source of truth; no AI in M3.
- **A09 Logging:** structured, secret-free job logs (reuse M1/M2 logger); ingest start/finish +
  per-DB outcome logged with `workspaceId`, counts — no PII, no cell values.

---

## 7. Scalability

- Snapshot reads instead of live Notion (ADR-1) — consumers never hit Notion per query.
- Ingestion paginates with backoff under Notion's ~3 req/s; full pull happens once per refresh,
  off the request path, on a worker.
- Two-version retention caps `NormalizedRecord` growth.
- In-memory aggregation is fine for MVP dataset sizes; SQL push-down and Redis caching (ADR-4)
  are deferred to M5 behind the existing data-access seam.

---

## 8. API surface

- `POST /api/snapshot` — zod-validated, workspace-scoped. Creates a `SnapshotRun` and enqueues
  `runSnapshot(snapshotRunId)`; returns `{ snapshotRunId }`. **Refuses (4xx) if the workspace
  has no approved mappings.**
- `GET /api/snapshot/[id]` — reads the **`SnapshotRun`** (not raw queue state), workspace-scoped:
  overall `status` (`queued | running | committed | partial | failed`) + per-database `results`
  (`{ sourceDatabaseId, status: 'ingested' | 'failed', rowCount?, error? }`). Mirrors
  `GET /api/scan/[scanRunId]`.

---

## 9. Data flow & state machine

```
approved DatabaseMapping(s) exist
   → POST /api/snapshot → create SnapshotRun(queued) → enqueue runSnapshot(snapshotRunId)
runSnapshot:
   load SnapshotRun → mark running, startedAt
   currentVersion = workspace.snapshotVersion           (N, 0 on first build)
   cleanOrphanCandidates(workspaceId, currentVersion)    (drop > N leftovers)
   for each approved database:
       typed-paginate all rows  → normalizeRow(...)      (collect warnings)
       writeSnapshotRecords(version = N+1)
       update SnapshotRun.results[db] = ingested | failed
   if all required DBs ingested:
       commitSnapshot(N+1):  bump snapshotVersion → N+1;  prune < N
       SnapshotRun → committed, snapshotVersion = N+1, finishedAt
   else:
       leave snapshotVersion = N (old snapshot stays live)
       SnapshotRun → partial (some ok) | failed (none ok), finishedAt
consumers (M4/M5):
   getCurrentSnapshotRecords(workspaceId) → metric engine → primitives / named facts
```

Overall status: `queued → running → committed | partial | failed`.

---

## 10. UI (`/app/scan`)

- Once all required mappings for the workspace are approved, show a prominent
  **"Build data snapshot"** CTA. After a committed snapshot exists, it reads
  **"Refresh data snapshot"** and shows **"Data last built at …"**.
- Clicking enqueues via `POST /api/snapshot`; the client polls `GET /api/snapshot/[id]` and
  renders per-database progress + a partial/failed retry affordance.
- Presentational glue over tested logic/endpoints (no new pure logic to unit-test in the Node
  env, per M2 precedent); verified via typecheck + build + manual smoke.

---

## 11. Testing strategy (TDD)

Pure-function unit tests (no DB, no network):

- `normalizeRow`: every role bucket; `ignore` dropped; null `occurredAt`; **invalid date →
  null + warning**; unparseable measure → dropped + warning; title extraction.
- `primitives`: count/sum/avg/min/max; `groupBy`; `bucketByTime` (day/week/month boundaries).
- `named` resolver: the supported cases **and** the unsupported/ambiguous **refusals** (the
  refusals are the guardrail — test them explicitly).

Typed extraction:

- Mocked Notion contract tests covering each `TypedValue` variant (number/date/select/
  multi-select/relation/empty).

Data layer:

- `commitSnapshot` atomic cutover: version bump + prune `< version - 1`, current + previous
  retained.
- `cleanOrphanCandidates` removes `> current` leftovers.
- `SnapshotRun` lifecycle: create→running→committed and create→running→partial/failed; per-DB
  `results` persisted; `startedAt`/`finishedAt` set.
- Tenant scope: assert no data-access path runs without `workspaceId`, and a `GET /api/snapshot/[id]`
  for another workspace's run is rejected (not leaked).

Integration (mocked Notion):

- approved mapping → ingest → records at `N+1` → `commitSnapshot` → a metric reads back the
  correct number from the current snapshot.
- All-or-nothing: one DB fails → `snapshotVersion` unchanged, old snapshot still readable.

---

## 12. New dependencies & secrets

- **No new external services or secrets.** Reuses the existing Notion connection/token,
  Postgres/Prisma, and the BullMQ/Redis **connection** already configured in M2. M3 is
  AI-free (no Anthropic). Note: M2's queue/worker is scan-specific, so M3 adds a **new**
  `SNAPSHOT_QUEUE` + worker registration (same Redis connection) — see §4 Jobs. (Redis
  aggregation **cache** — a distinct use — is deferred to M5.)

---

## 13. Build sequence (for the plan)

1. Prisma `NormalizedRecord` + `SnapshotRun` models + migration (additive).
2. `TypedValue`/`TypedRow` (discriminated) + `NormalizedRecordInput` contracts (zod).
3. Typed Notion read path (`queryDatabaseRowsTyped`).
4. `normalizeRow` (pure) + warnings.
5. Metric primitives (pure).
6. Named resolver (pure, conservative).
7. `lib/data/normalized.ts` (write / commit / clean / read) + `lib/data/snapshot-runs.ts`
   (create / update results / set status) — all workspace-scoped.
8. `runSnapshot` job handler (all-or-nothing, updates `SnapshotRun`) + new `SNAPSHOT_QUEUE`
   queue/worker wiring.
9. `POST /api/snapshot` (creates `SnapshotRun`) + `GET /api/snapshot/[id]` (reads it).
10. UI CTA + poll + retry on `/app/scan`.

Each task is TDD: failing test → run → minimal impl → run → commit (conventional, scoped).

---

## 14. Open questions / risks

- **Dataset size vs. in-memory aggregation** — fine for MVP; revisit at M5 if a workspace's
  current snapshot is large enough to warrant SQL push-down. Seam is already in place (D-6).
- **Notion type coverage** — formula/rollup/files property types: decide per-type mapping to a
  `TypedValue` kind (likely `text`/`list`/`empty`) during typed-reader implementation; anything
  unmapped resolves to `empty` + a normalization warning, so gaps are visible rather than silent.