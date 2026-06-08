# NotionIQ M2 — Understand Workspace · Design Spec

**Date:** 2026-06-08
**Milestone:** M2 (roadmap `Plans/00-ROADMAP.md`; plan file `Plans/03-scanner-schema-mapper.md`)
**Depends on:** M1 (Notion connect — encrypted token at rest, workspace/membership model)
**Source spec:** `docs/superpowers/specs/2026-06-05-notioniq-mvp-design.md`

---

## 1. Summary

M2 is the **front half of the analyst pipeline**: connect → **understand the workspace** →
hand M3 a clean contract. Its single deliverable is an **approved, stored schema mapping** per
selected Notion database — the typed contract M3 consumes to build `NormalizedRecord` and metric
snapshots.

The flow is **select-then-scan with human-in-the-loop review**:

1. **List** the databases the Notion integration can access (lightweight, synchronous).
2. **Select** — the user picks the databases that matter.
3. **Scan + map** (background job) — read each selected database's schema + a transient row sample,
   seed property roles from Notion's own types (deterministic), then let the AI do the semantic work
   (classify the database, choose the single timeline field, resolve ambiguity, score confidence).
4. **Review** — the user inspects each proposed mapping, corrects roles, and approves per database.
5. **Persist** — the approved mapping becomes the durable contract for M3.

This is the **first use of the Anthropic API** and the **first BullMQ/Redis job boundary** in the
codebase. Establishing the job boundary now (while scope is small) avoids rebuilding it in M3.

### Core principle (inherited)

> Notion = system of record · Analytics Engine = truth · AI = interpretation · Human = final approval.

In M2 the AI **interprets schema** — it never computes numbers and never has the final say. Notion's
property types are a deterministic prior; the human approves the result.

---

## 2. Scope & boundary

**In scope (M2):**
- List accessible databases (databases only, minimal metadata).
- Select-then-scan of the chosen databases.
- Deterministic candidate-role rules from Notion property types.
- AI schema mapper (classification, role refinement, `occurredAt` selection, confidence + rationale).
- Background scan job (BullMQ/Redis) with per-database progress + partial-failure handling.
- Human review UI: inspect, correct, approve per database.
- Persist `WorkspaceScanRun` + `DatabaseMapping` (durable approved mapping).

**Explicitly NOT in scope (later milestones):**
- `NormalizedRecord`, metric computation, `Workspace.snapshotVersion` bump — **M3**.
- Insights, verifier, report writing — **M4**.
- Charts, filters, embeds — **M5**.
- Scheduled refresh, full tracing/observability (Langfuse), billing gating — **M6**.
- **RAG / vector retrieval** — not in M2. The mapper's context (selected DB names, property
  names/types, option names, relation targets, a transient sample) is small, fresh, and
  tenant-specific; RAG's ingestion/permissions/stale-index cost buys nothing here. Revisit in M4+
  for page/doc understanding, business-definition retrieval, and cross-workspace mapping reuse.
- **Persisting raw row values / page content** — never (see §6).

---

## 3. Architecture decisions

### D-1 — Background job from the start (BullMQ/Redis), kept thin

The scan + AI mapping runs as a **BullMQ background job**, not inline in a request. Notion
pagination/rate limits, Anthropic latency, retries, and partial failure all want a job boundary, and
M3 would otherwise rebuild it.

- `POST /api/scan` only: validates workspace access, creates a `WorkspaceScanRun`, enqueues the job,
  returns `{ scanRunId }`.
- The **worker** does the heavy lifting and writes progress/errors.
- The **review UI polls** scan status until the proposal is ready.

**Listing is the exception:** it is a lightweight, paginated read (no row fetches) and stays a
**synchronous** server route — no job needed.

### D-2 — Select-then-scan (user curates scope)

The user picks databases before any scan. Auto-scanning everything the integration can see invites
noise (archived/test/unrelated shared databases) and burns rate limit + AI tokens before the app
knows what matters. Starting from user intent also makes the review UI cleaner. "Select all" /
recommended candidates can come later; the default is user-selected.

### D-3 — Hand-rolled Notion read client (fetch + zod)

The scanner needs three narrow reads — `search` (databases only), retrieve database, query database
rows. We extend M1's `lib/notion/oauth.ts` pattern: thin `fetch` wrapper, zod-validated responses,
injectable `fetchImpl`, pinned to `Notion-Version: 2022-06-28`. No SDK dependency; we validate
exactly the subset we consume; tests stay stable. Revisit `@notionhq/client` only if scanner scope
expands materially.

**Version-isolation note:** the `Notion-Version` header, raw endpoint shapes, and Notion's
"database/data source" terminology stay **entirely behind `notion-client.ts`**. The rest of the
codebase consumes only our domain types (`ScannedDatabase`, `FieldMapping`, etc.) and never
references Notion wire fields directly. When the `2025-09-03` "data sources" model eventually lands,
the migration is contained to this one module rather than rippling through scanner, mapper, and UI.

### D-4 — Deterministic prior + AI refine

A **pure rules pass** seeds candidate roles from Notion property types; the **AI refines**. The AI
does interpretation (classify the database, pick the single `occurredAt`, resolve ambiguous fields,
score confidence, flag shaky guesses) — not mechanical type-reading. Cheaper, more reliable, smaller
AI error surface, and the rules pass is exhaustively unit-testable. Fits "AI interprets, the engine
is truth."

### D-5 — Lean core taxonomy

Roles: `date` (→ `occurredAt`), `measure`, `dimension`, `status`, `title`, `ignore`. Plus a
free-text `classification` per database and **confidence + rationale per field**. A richer typed
ontology (currency-vs-count, person/owner, ordered status, entity ids) is deferred until real
workspaces show it is needed — over-specifying now makes the AI less reliable, the review UI harder,
and forces M3 to support distinctions it may not use.

### D-6 — Persist schema + mapping; samples are transient

We persist database **schema metadata** and the **mapping** (proposed + approved); we never persist
raw cell values, page content, or full row payloads. Sample rows are read by the worker, fed to the
mapper, then discarded. Minimizes stored customer data. If review-UI examples are ever needed, use
short-lived in-memory/job-cache samples with a TTL — not Postgres.

### D-7 — Plain orchestration + lightweight observability (no LangGraph, defer LangSmith)

The orchestration is linear and statefully ordinary: scan → candidate rules → AI mapper →
validate → persist → human review. A **BullMQ queue + a plain `runScan(scanRunId)` handler** is
enough; **LangGraph is not used** — it would add a second execution model, state representation, and
debugging surface before any genuinely branching/multi-agent workflow exists (revisit in M4+ if one
does).

**LangSmith/Langfuse tracing is deferred** (M6). Beyond not-yet-needed, it carries a concrete risk in
M2: the mapper sees raw Notion sample rows, and a trace store would export that business data to a
third party. We will not wire a trace store until prompt/sample content can be reliably excluded or
redacted.

M2 observability is therefore lightweight and self-hosted in our own logs:
- structured logs of `scanRunId`, `workspaceId`, database count, and status transitions;
- AI **metadata only** — model, **prompt version**, latency, token counts, schema-validation failures;
- **never** prompt body, sample rows, cell values, or Notion tokens;
- `mapperModel` + `mapperPromptVersion` stored on the scan run and proposal for reproducibility.

### D-8 — `DatabaseMapping` is current state; run history lives on the scan run

`DatabaseMapping` is the **durable, current** mapping for a `(workspaceId, notionDatabaseId)` pair
(unique). A re-scan **updates it in place** via a `lastScanRunId` pointer — it does **not** create
historical mapping rows. Per-run outcomes (which databases scanned/mapped/failed) live on
`WorkspaceScanRun.results`. This keeps a single, unambiguous source of truth for M3
(`approvedMapping` where `status = approved`) and avoids data-model churn when M3 starts consuming.

**Run-level approval is derived, not independently set.** `WorkspaceScanRun.status` becomes
`approved` exactly when **every non-failed selected database in the run has an approved mapping**;
until then it stays `proposed`. The approve endpoint recomputes this after each per-database approval
and transitions the run when the condition is met. (Failed databases do not block run approval — they
are surfaced in `results` for the user to re-scan.)

**Re-scan vs. an existing approval (schema-hash gated).** Each `DatabaseMapping` stores a
`schemaHash` (stable hash of property ids + types + option sets). On re-scan:
- **`schemaHash` unchanged** → the database's structure is the same; we refresh `proposedMapping`
  but **preserve `approvedMapping` and keep `status = approved`** (no needless re-review).
- **`schemaHash` changed** (properties added/removed/retyped, options changed) → the prior approval
  may no longer be valid, so **`status` is set back to `proposed`** and the database re-enters review.
  The prior `approvedMapping` is retained (for diff/UX) but is **not** treated as current by M3, since
  M3 reads `approvedMapping` only where `status = approved`.

---

## 4. Components

Each unit has one responsibility, a typed interface, and is independently testable.

### Notion reads
- **`lib/notion/notion-client.ts`** — `searchDatabases({ cursor })` (databases only), `retrieveDatabase(id)`,
  `queryDatabaseRows(id, { cursor, pageSize })`. Hand-rolled `fetch` + zod, injectable `fetchImpl`,
  `Notion-Version: 2022-06-28`. Decrypts the access token via
  `decryptToken(connection.encryptedToken, KEY, connection.notionWorkspaceId)` — server-side only.
- **`lib/notion/rate-limiter.ts`** — token-bucket limiter (~3 req/s) + exponential backoff on
  429/5xx. Pure, deterministic (clock injectable), unit-tested.
- **`lib/notion/scanner.ts`** — orchestrates a scan: for each selected database, paginate schema +
  fetch a **bounded transient sample**, returning an in-memory `ScannedDatabase[]`
  (`{ notionDatabaseId, databaseName, schema, sampleForMapper }`). Never persists raw values.
  - **Sample & prompt bounds (constants, drive privacy + cost + tests):**
    `MAX_SAMPLE_ROWS = 20` per database; `MAX_PROPERTIES = 50` (excess properties beyond the cap are
    listed by name/type but excluded from the sample, and the proposal notes truncation);
    `MAX_CELL_CHARS = 200` (cell values truncated with an ellipsis before they reach the mapper);
    `MAX_OPTION_NAMES = 50` per select/status (excess options counted, not enumerated). These are
    single-sourced constants so tests assert exact truncation behavior.

### Mapping
- **`lib/mapping/candidate-rules.ts`** — **pure fn**: Notion property type → candidate role.
  - `title → title`
  - `date`, `created_time`, `last_edited_time` → `date`
  - `number`, number-returning `formula`, `rollup` (number) → `measure`
  - `select`, `multi_select`, `relation`, `people` → `dimension`
  - `status` → `status` (with `dimension` as fallback)
  - everything else (rich_text, files, url, email, phone, checkbox, etc.) → `ignore`
- **`lib/contracts/mapping.ts`** — shared zod contract for the mapping proposal/approval, imported by
  worker, API, review UI, and (later) M3. Defines `Role`, `FieldMapping`
  (`{ notionPropertyId, name, notionType, optionNames?, relationTargetName?, candidateRole, role,
  confidence, rationale }`), and `DatabaseMappingProposal`
  (`{ classification, occurredAtPropertyId, fields, modelVersion, promptVersion }`).
- **`lib/agents/anthropic-client.ts`** — thin injectable Anthropic wrapper (mockable like `fetchImpl`).
- **`lib/agents/schema-mapper.ts`** — builds the prompt from schema + candidate roles + a compact
  sample; calls Claude with **forced tool-use** whose input schema mirrors `lib/contracts/mapping.ts`;
  validates the tool input with zod. On invalid/mismatched output, performs **one bounded repair
  re-prompt** including the validation error; if it still fails, the database's result is `failed`
  with an `errorCode` — a bad mapping is **never** silently accepted. Logs model/latency/token-count
  only (see §6).
  - **Rationale containment rule (hard):** the prompt instructs that each field's `rationale` may
    reference **only** schema vocabulary — property names, Notion types, and option/relation-target
    names — and **never** raw sample cell values. The zod contract caps rationale length
    (≤ 200 chars) and the mapper applies a lightweight guard: if a rationale contains a token present
    in the transient sample but **absent** from the schema vocabulary, the field is flagged and its
    rationale dropped. This keeps "samples are transient" true even though rationale is persisted and
    shown in the review UI.

### Jobs & persistence
- **`lib/jobs/queue.ts`** — thin BullMQ queue + worker wiring (connection from `REDIS_URL`).
- **`lib/jobs/run-scan.ts`** — the job handler `runScan(scanRunId)`: a plain async fn composing
  scanner → candidate-rules → schema-mapper → persistence. Tested **directly** with mocked Notion + AI;
  no live Redis required.
- **`lib/data/scan-runs.ts`** — tenant-scoped create/read/update of `WorkspaceScanRun` (status,
  `results`).
- **`lib/data/mappings.ts`** — tenant-scoped upsert/read of `DatabaseMapping` (proposed + approve).

### Model selection
Default mapper model **Claude Sonnet 4.6** (`claude-sonnet-4-6`) — schema classification is moderate
structured reasoning where Sonnet balances quality, latency, and cost. The model id and prompt
version are stored on the run (`mapperModel`, `mapperPromptVersion`) and the proposal
(`modelVersion`, `promptVersion`) for traceability/reproducibility; swapping models later is a
one-line change.

---

## 5. Data model (Prisma, additive — no destructive migration)

```prisma
model WorkspaceScanRun {
  id                  String   @id @default(cuid())
  workspaceId         String
  workspace           Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  status              String   @default("queued") // queued | running | proposed | approved | failed
                                                  // `approved` is DERIVED: all non-failed selected mappings approved
  selectedDatabaseIds Json     // string[] of Notion database ids
  results             Json?    // [{ notionDatabaseId, status: scanned|mapped|failed, errorCode? }]
  propertyCount       Int?     // aggregate scan stat
  sampleRowCount      Int?     // aggregate scan stat
  mapperModel         String?  // model id used (traceability)
  mapperPromptVersion String?  // mapper prompt version (reproducibility)
  error               String?  // run-level failure summary (no PII)
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
  schema           Json     // property metadata: name, notionType, optionNames?, relationTargetName?
  schemaHash       String   // stable hash of property ids + types + option sets (re-scan gate)
  proposedMapping  Json     // DatabaseMappingProposal (latest AI proposal)
  approvedMapping  Json?    // DatabaseMappingProposal (human-approved; the M3 contract)
  status           String   @default("proposed") // proposed | approved
                                                 // re-scan with changed schemaHash resets approved → proposed
  confidence       Float?   // overall proposal confidence (0..1)
  lastScanRunId    String
  lastScanRun      WorkspaceScanRun @relation(fields: [lastScanRunId], references: [id])
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@unique([workspaceId, notionDatabaseId]) // current state; re-scan updates in place
  @@index([workspaceId])
}
```

`Workspace` gains the back-relations (`scanRuns`, `databaseMappings`). `Workspace.snapshotVersion`
stays `0` in M2 (M3 owns it).

---

## 6. Security (OWASP-aligned)

- **A01 access control:** every scan-runs/mappings query is tenant-scoped by `workspaceId`; the user's
  workspace ownership is verified (via `WorkspaceMember`) before listing, scanning, polling, or
  approving.
- **A02 crypto:** the Notion token is decrypted only in the worker/scanner path
  (`decryptToken(..., notionWorkspaceId)` as AAD), never in the client/iframe. New secrets read via
  `getEnv()`; `.env.example` gets placeholders only.
- **A03 injection:** Prisma parameterized queries; zod-validate **every** boundary — list, scan,
  poll, approve — and the AI tool output.
- **A04 insecure design:** AI never computes numbers; it proposes a mapping a human must approve;
  Notion property types are a deterministic prior.
- **A05 misconfig / data minimization:** **never persist** raw cell values, page content, or full row
  payloads. Only schema metadata + mapping persist. Samples are transient. The AI `rationale` is
  persisted and shown in the UI, so it is subject to the **rationale containment rule** (§4
  schema-mapper): rationale may reference only schema vocabulary, never sample values — enforced by
  prompt + a length cap + a sample-token guard.
- **A07 auth:** Clerk-gated app routes; mutating POSTs (`/api/scan`, `/api/mappings/[id]/approve`)
  carry the same-origin guard established for `/api/notion/disconnect` (route handlers are not covered
  by Next's built-in Server Action CSRF check).
- **A08 integrity:** the AI tool output is zod-validated with a bounded repair retry; invalid output
  becomes a `failed` mapping, never a silently accepted bad one.
- **A09 logging:** structured, secret-free logs (`lib/log.ts`): `scanRunId`, `workspaceId`, database
  count, status transitions. For AI calls log **only** model, prompt version, latency, token counts,
  and schema-validation failures — **never** prompt content, sample rows, cell values, or rationale
  text (may carry user business data). No tokens/secrets/PII. Third-party trace stores
  (LangSmith/Langfuse) are deferred (M6, D-7) precisely because they would export sample content.
- **A10 SSRF:** outbound calls go only to Notion and Anthropic hosts; no user-supplied URLs are
  fetched.

---

## 7. Scalability

- Listing is paginated with a **bounded page limit** and returns minimal metadata.
- Scanning paginates schema + a bounded sample per database, behind the ~3 req/s rate-limiter with
  backoff.
- Heavy work runs on the BullMQ worker, off the request path.
- AI cost is bounded: one mapper call per selected database (plus at most one repair retry); the
  deterministic prior keeps prompts compact.

---

## 8. API surface

| Method | Path | Type | Purpose |
| ------ | ---- | ---- | ------- |
| `GET`  | `/api/notion/databases` | sync | List accessible **databases only**, minimal metadata (id, title, icon, lastEditedTime), tenant-scoped, bounded page limit, explicit empty/error states. |
| `POST` | `/api/scan` | sync→enqueue | Validate access + selected ids → create `WorkspaceScanRun{queued}` → enqueue → `{ scanRunId }`. Same-origin guarded. |
| `GET`  | `/api/scan/[scanRunId]` | sync | Poll run `status` + `results` (per-database progress). Tenant-scoped. |
| `POST` | `/api/mappings/[id]/approve` | sync | Persist corrected mapping (zod-validated against `lib/contracts/mapping.ts`), set `status=approved`. Same-origin guarded, tenant-scoped. |

---

## 9. Data flow & state machine

```
Connect ─▶ GET /api/notion/databases      (sync: search, databases only, bounded)
         ─▶ user selects databases
POST /api/scan  → validate access + ids → create WorkspaceScanRun{status:queued}
                → enqueue BullMQ job → return { scanRunId }

worker runScan(scanRunId): status queued → running
   for each selected database:
     scanner: schema + transient sample
     candidate-rules (pure) → schema-mapper (AI, forced tool-use + zod, 1 repair retry)
     compute schemaHash; upsert DatabaseMapping{lastScanRunId, proposedMapping}
       - new db, or schemaHash changed → status = proposed (re-review)
       - schemaHash unchanged → preserve approvedMapping + keep prior status
     append results[] { notionDatabaseId, status: mapped | failed, errorCode? }
   status running → proposed     (partial failure: run still `proposed`; failed dbs flagged in results)
   run-level fatal error → status failed, error summary

UI polls GET /api/scan/[scanRunId] until proposed | failed
User reviews each proposed mapping → edits roles
POST /api/mappings/[id]/approve → approvedMapping saved, DatabaseMapping.status = approved
   → endpoint recomputes run: if all non-failed selected mappings approved, run.status = approved
```

`WorkspaceScanRun.status`: `queued → running → proposed → approved`, plus `failed`. `approved` is
**derived** — set only when every non-failed selected mapping is approved.
`DatabaseMapping.status`: `proposed → approved`; a re-scan with a changed `schemaHash` resets an
approved mapping back to `proposed`.

---

## 10. Review UI (`/app`)

Server components + small client islands. Following the repo's testing reality (Node test env, no
React Testing Library), UI **logic** lives in pure functions tested directly (the approach used for
the M1.1 status banner); components stay thin and presentational.

Screens:
1. **Database picker** — checkboxes over accessible databases (name, icon, last-edited); submit
   selection.
2. **Scan progress** — polls the run; shows per-database status ("3 mapped, 1 failed").
3. **Mapping review (per database)** — for each property: name, Notion type, **option names**
   (select/status) or **relation target name** where available, the candidate role, the AI-chosen
   role (editable dropdown), confidence, and rationale. Low-confidence fields are flagged. The chosen
   `occurredAt` is highlighted. **No raw row values are shown** — only schema-derived context.
   Approve persists the corrected mapping (per database).

---

## 11. Testing strategy (TDD)

- **Pure unit:** `candidate-rules` (every Notion type → expected candidate), `rate-limiter`
  (throttle + backoff with injected clock), `lib/contracts/mapping.ts` (zod accept/reject, incl.
  rationale length cap), mapping-merge/normalization (apply human edits onto a proposal), `schemaHash`
  (stable across reorder, changes on type/option edits), sample bounding (row/property/cell/option
  truncation hits the exact constants), rationale sample-token guard (drops a rationale containing a
  sample-only token).
- **Contract tests:** `notion-client` with mocked `fetchImpl` (databases-only filter, pagination,
  429 backoff, zod rejection of malformed responses).
- **Agent tests:** `schema-mapper` with a mocked Anthropic client — valid tool output, schema
  mismatch → repair retry → success, repair failure → `failed` with errorCode.
- **Data tests:** `scan-runs` / `mappings` tenant-scoping + upsert-in-place semantics; re-scan with
  unchanged `schemaHash` preserves `approved`, changed `schemaHash` resets to `proposed`; run becomes
  `approved` only when all non-failed selected mappings are approved.
- **Job handler:** `runScan` tested directly with mocked Notion + AI (no live Redis), incl. partial
  failure populating `results`.
- **Route tests:** auth + same-origin guard + zod rejection on `/api/scan`, `/api/scan/[id]`,
  `/api/mappings/[id]/approve`, `/api/notion/databases`.
- **Optional e2e:** select → scan (mocked AI) → approve, asserting the persisted `approvedMapping`.

Gate before any merge: `npm run typecheck && npm run lint && npm run test && npm run build`.

---

## 12. New dependencies & secrets

- **Dependencies:** `bullmq`, `ioredis` (queue/worker), `@anthropic-ai/sdk` (mapper).
- **Secrets (via `lib/env.ts` `getEnv()` + `.env.example` placeholders only):**
  `ANTHROPIC_API_KEY`, `REDIS_URL`.
- **Local dev:** a Redis container alongside the existing Postgres container; the worker runs as a
  separate `npm` script.

---

## 13. Build sequence

1. Prisma models (`WorkspaceScanRun`, `DatabaseMapping`) + migration; env additions.
2. `lib/notion/rate-limiter.ts`.
3. `lib/notion/notion-client.ts` (search/retrieve/query reads).
4. `lib/notion/scanner.ts`.
5. `lib/mapping/candidate-rules.ts` + `lib/contracts/mapping.ts`.
6. `lib/agents/anthropic-client.ts` + `lib/agents/schema-mapper.ts`.
7. `lib/jobs/queue.ts` + `lib/jobs/run-scan.ts`.
8. API routes: list, scan, poll, approve.
9. Review UI: picker, progress, mapping review.
10. Wire-up + optional e2e.

---

## 14. Open questions / risks

- **Notion API version:** pinned to `2022-06-28` (classic "databases"); the newer `2025-09-03`
  "data sources" model reshapes querying and is deferred. Migration risk is contained by the
  version-isolation note (D-3) — all Notion wire details live behind `notion-client.ts`.
- **Large databases:** schema is bounded, but very wide schemas (100+ properties) could enlarge the
  mapper prompt — mitigated by sending candidate roles + a compact sample, not full data.
- **Redis in CI/local:** the job handler is tested without live Redis; CI need not run a Redis service
  for M2 unless an integration test for the queue itself is added.
