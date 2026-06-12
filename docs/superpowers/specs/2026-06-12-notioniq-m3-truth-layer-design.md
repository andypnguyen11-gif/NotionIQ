# NotionIQ M3 — Truth Layer · Design Spec

**Status:** approved (brainstorm) — ready for plan
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
  `TypedValue = number | string | string[] | { date: string } | null` (discriminated/typed).
- New client method `queryDatabaseRowsTyped(databaseId, { cursor, pageSize })` — full
  pagination through the existing rate-limiter + backoff helper, extracting native Notion types
  (number→number, date→ISO string, select/status→string, multi-select/relation→string[]).
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

- `runSnapshot(workspaceId)` job handler: load approved mappings → for each, typed-paginate +
  `normalizeRow` → `writeSnapshotRecords(N+1)` → if all succeed `commitSnapshot(N+1)`, else
  leave active version untouched and report partials.
- Queue + worker wired like the M2 scan queue.

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

`Workspace.snapshotVersion` already exists (M2 schema, default `0`). No change to its
definition; M3 starts writing it past `0`.

`mappedFields` JSONB shape:

```jsonc
{
  "measures":   { "<fieldId>": { "name": "Amount", "value": 1990.0 } }, // numbers stay numbers
  "dimensions": { "<fieldId>": { "name": "Region", "value": "EMEA" } },
  "status":     { "<fieldId>": { "name": "Stage",  "value": "Won"  } },
  "title":      { "value": "Acme renewal" }
}
```

Optional run bookkeeping (decide in planning): a lightweight `SnapshotRun` record (status,
per-DB results, counts) mirroring `WorkspaceScanRun`, **or** reuse the job/poll status only.
The plan picks the lighter option that still drives the poll UI.

---

## 6. Security (OWASP-aligned)

- **A01 Access control:** every `lib/data/normalized.ts` function is workspace-scoped; no read
  or write without `workspaceId`. Snapshot trigger/poll endpoints resolve the caller's
  workspace via Clerk → `WorkspaceMember`, never a client-supplied id.
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

- `POST /api/snapshot` — zod-validated, workspace-scoped. Enqueues `runSnapshot`; returns a job
  id. **Refuses (4xx) if the workspace has no approved mappings.**
- `GET /api/snapshot/[id]` — poll status + per-database results
  (`{ sourceDatabaseId, status: 'ingested' | 'failed', rowCount?, error? }`) and overall status
  (`queued | running | committed | partial | failed`). Mirrors `GET /api/scan/[scanRunId]`.

---

## 9. Data flow & state machine

```
approved DatabaseMapping(s) exist
   → POST /api/snapshot → enqueue runSnapshot(workspaceId)
runSnapshot:
   currentVersion = workspace.snapshotVersion           (N, 0 on first build)
   cleanOrphanCandidates(workspaceId, currentVersion)    (drop > N leftovers)
   for each approved database:
       typed-paginate all rows  → normalizeRow(...)      (collect warnings)
       writeSnapshotRecords(version = N+1)
       per-DB result: ingested | failed
   if all required DBs ingested:
       commitSnapshot(N+1):  bump snapshotVersion → N+1;  prune < N
       status = committed
   else:
       leave snapshotVersion = N (old snapshot stays live)
       status = partial (some ok) | failed (none ok)
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
- Tenant scope: assert no data-access path runs without `workspaceId`.

Integration (mocked Notion):

- approved mapping → ingest → records at `N+1` → `commitSnapshot` → a metric reads back the
  correct number from the current snapshot.
- All-or-nothing: one DB fails → `snapshotVersion` unchanged, old snapshot still readable.

---

## 12. New dependencies & secrets

- **No new external services or secrets.** Reuses Anthropic-free deterministic code, the
  existing Notion connection/token, Postgres/Prisma, and the BullMQ/Redis queue already wired
  in M2. (Redis aggregation **cache** — a distinct use — is deferred to M5.)

---

## 13. Build sequence (for the plan)

1. Prisma `NormalizedRecord` model + migration (additive).
2. `TypedValue`/`TypedRow` + `NormalizedRecordInput` contracts (zod).
3. Typed Notion read path (`queryDatabaseRowsTyped`).
4. `normalizeRow` (pure) + warnings.
5. Metric primitives (pure).
6. Named resolver (pure, conservative).
7. `lib/data/normalized.ts` (write / commit / clean / read) — all workspace-scoped.
8. `runSnapshot` job handler (all-or-nothing) + queue/worker wiring.
9. `POST /api/snapshot` + `GET /api/snapshot/[id]`.
10. UI CTA + poll + retry on `/app/scan`.

Each task is TDD: failing test → run → minimal impl → run → commit (conventional, scoped).

---

## 14. Open questions / risks

- **`SnapshotRun` table vs. job-status-only** (§5) — decide in planning; prefer the lighter
  option that still drives the poll UI.
- **Dataset size vs. in-memory aggregation** — fine for MVP; revisit at M5 if a workspace's
  current snapshot is large enough to warrant SQL push-down. Seam is already in place (D-6).
- **Notion type coverage** — formula/rollup/people/files property types: decide per-type
  extraction (likely `string`/`string[]`/`unsupported→null+warning`) during typed-reader
  implementation; the warning path makes gaps visible rather than silent.
```