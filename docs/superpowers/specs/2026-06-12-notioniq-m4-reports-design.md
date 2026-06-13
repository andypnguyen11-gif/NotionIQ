# NotionIQ M4 — Reports (Insight + Verifier + Report Writer) · Design Spec

> **Milestone:** M4 (depends on M3 Truth Layer)
> **Source roadmap:** `Plans/00-ROADMAP.md`
> **Source MVP spec:** `docs/superpowers/specs/2026-06-05-notioniq-mvp-design.md`
> **Builds on:** M3 truth layer (`docs/superpowers/specs/2026-06-12-notioniq-m3-truth-layer-design.md`)

---

## 1. Summary

M4 turns the M3 truth layer into a written **AI Business Review** inside Notion. A manual trigger
generates a report over the **current committed snapshot**: a deterministic *fact sheet* is built from
the metric engine, an isolated **insight agent** drafts interpretation as **structured claims**, a
deterministic **verifier** gates every claim against the engine, and a **report writer** publishes the
surviving claims into a single managed Notion page. Report history and the verifier audit trail live in
Postgres; Notion holds only the current published report.

### Core principle (inherited from the MVP spec)

> Notion = system of record · Analytics Engine = truth · AI = interpretation · Verifier = safety · Human = final approval.

The AI never computes or invents numbers. It emits **templates with placeholders** plus a **structured
assertion**; the engine supplies every rendered number. The verifier re-runs the engine and gates the
assertion before anything reaches Notion (MVP spec ADR-4; PRD AI guardrails).

---

## 2. Scope & boundary

**In scope:**

- A deterministic **fact sheet** built from the M3 metric engine over the current snapshot, including
  current-vs-previous-snapshot deltas (M3 retains `N` and `N-1`).
- One **insight agent** call (isolated, `ToolCaller` pattern) producing structured claims.
- A deterministic **verifier** that recomputes each referenced fact and gates the claim.
- A **report writer** that publishes verified claims into a single managed Notion page, idempotently.
- Postgres persistence: `Report` (current managed destination), `ReportRun` (append-only generation
  history), `ReportClaim` (verifier audit trail with frozen fact values).
- A manual **"Generate AI Business Review"** trigger + run status, alongside the existing scan/snapshot UI.

**Out of scope (deferred):**

- **Billing/entitlement gating** → M6. M4 builds report generation behind a clean trigger boundary that
  M6 can wrap with the Free "1 manual report" cap.
- **Chart embeds** in the report → M5 (M4 leaves a predictable slot in the managed region).
- **Scheduled refresh** → M6.
- **Standalone `ActionItem` entity** (assignment, due dates, completion). M4 folds recommendations into
  `ReportClaim(kind: recommendation)`.
- **Golden-dataset AI evals** for insight/verifier quality → M7 (consistent with the MVP eval plan).
- **Long-term report/business memory** beyond the per-run audit trail → later.

---

## 3. Architecture decisions

### D-1 — Report generation is an explicit, user-triggered BullMQ job

Same shape as the M2 scan and M3 snapshot jobs: a same-origin, authenticated `POST /api/report` creates a
`ReportRun`, enqueues it, and returns `202 {reportRunId}`. The heavy work (engine, one AI call, Notion
writes) runs on a worker. The Notion token is decrypted only in the worker (M1 pattern).

### D-2 — Hybrid insight↔verifier contract: numbers by-reference, assertions verified

The AI emits structured claims, never raw numbers. Each claim carries a `metricRequest` reference (by
`factId`), a typed **assertion**, and a **template** whose placeholders are resolved from the verified
fact. The verifier deterministically recomputes the referenced fact and gates the assertion. This honors
"AI never computes numbers" by construction *and* gives the verifier real teeth against AI drift in
superlatives, trends, and comparisons. Rejected alternatives: pure by-construction (too trusting of AI
qualitative phrasing) and generate-then-verify prose (fragile NL parsing, AI still emits numbers).

### D-3 — Deterministic, ranked, bounded fact sheet is the AI's only input

A deterministic catalog builder enumerates valid metric requests from approved mappings (per
classification: each measure × `{count, sum, average, min, max}`, optionally grouped by one
low-cardinality dimension, optionally time-bucketed), **ranks** them by likely salience, and **bounds**
the set with cardinality caps *before* the AI sees them (ranked-then-bounded, not capped-after-enumeration).
The AI sees the computed numbers — the rule is "AI can't invent or compute numbers," not "AI can't look
at them."

The fact sheet and the verifier both compute via the M3 **primitives** (`count`/`sum`/`avg`/`min`/`max`/
`groupBy`/`bucketByTime`) directly — all of which shipped in M3. It deliberately does **not** depend on
`resolveNamedMetric`, whose `min`/`max`/`groupBy` wiring was a deferred M3 item; computing through the
primitives keeps M4 free of that dependency and keeps fact and verifier on the identical code path.

### D-4 — Verifier is deterministic code, not an AI judge

The verifier recomputes each referenced fact from its `metricRequest` against the current snapshot and
compares within a **strict tolerance** (exact for counts/integers; relative epsilon for floats; deltas
recompute the previous value too). It is pure code with no model call — deliberately not "another
AI-judgment layer." Recommendations are gated too: a recommendation must cite at least one **verified**
fact.

### D-5 — One repair retry total per run

After the single insight call, a combined **parse + verify** pass collects *all* failures (malformed
structure and mismatched/unsupported/unevidenced claims) and issues **one** repair prompt covering
everything. The repaired output is re-parsed and re-verified once; whatever still fails is dropped. Exactly
one AI repair round per run — never two.

### D-6 — Single managed Notion page per workspace, rewritten in place

One `Report` per workspace is the durable published destination. It is auto-created on first run (under a
captured parent page if M1/M2 supplied one, else the integration-accessible root) and **rewritten in
place** thereafter. This gives the user one stable "AI Business Review" page, gives M5 a stable home for
chart embeds, and makes idempotency and future scheduled refresh clean. No destination picker in M4
(a "change report destination" setting can come later).

### D-7 — Managed-region idempotency via recorded block IDs

The writer owns only the blocks it created, recorded as `Report.ownedBlockIds`. On re-run it deletes
exactly those IDs, then inserts the new managed region and saves the new ID set — never touching the
user's own content, the title, or hand-added blocks. **Sentinel start/end blocks wrap the managed region**
as mandatory-but-non-authoritative markers for human/debug visibility and future reconciliation;
`ownedBlockIds` remains the authoritative delete list.

### D-8 — Persist claims before the Notion write

The job persists the `ReportRun` result and all `ReportClaim`s (with frozen fact values and token usage)
**before** attempting the Notion write. A write failure therefore ends as `write_failed` with the audit
trail intact and the old report still live — never `failed` with lost claims.

### D-9 — Reports are immutable historical artifacts; freeze fact values

`ReportClaim` stores the **frozen `factValue`/`factSnapshot`** at write time (plus `snapshotVersion` /
`computedAt`), not just `factId`. A report from snapshot `N` still reads correctly after snapshot `N+2`
changes the underlying numbers.

### D-10 — Single-flight report runs per workspace

At most one in-flight (`queued|running`) `ReportRun` per workspace, enforced by a partial unique index
(DB backstop) plus an application-level find-or-create with `P2002` fallback — the exact pattern M3 uses
for snapshot runs. Prevents overlapping writes to the same managed page.

---

## 4. Components

### Fact sheet (`lib/reports/fact-sheet.ts`)

Pure (engine in, data out). Enumerates candidate `MetricRequestSpec`s from approved mappings, ranks them
by salience, bounds them with cardinality caps, and computes each `Fact` (scalar `value` or bounded/ranked
`groups`, plus `previousValue`/`delta` when a previous snapshot exists). `factId` is a deterministic hash
of the canonical (sorted) `metricRequest` + `snapshotVersion`, so the verifier recomputes the identical id
independently. Trends are **absent, not guessed**, when there is no previous snapshot.

### Insight agent (`lib/agents/insight.ts`)

The single AI call, following the M2 `schema-mapper` pattern: `ToolCaller` (injected SDK, no network in
tests), `PROMPT_VERSION`, a forced tool schema, zod validation, structured logging of token usage. Input:
the fact sheet plus light context (database names/classifications). Output: `InsightClaim[]` — each with a
`section`, a `template`, a typed `assertion`, and an optional `severity`. The agent never emits a final
number; only templates + assertions.

### Verifier (`lib/reports/verifier.ts`)

Pure. For each claim: recompute the referenced fact, validate the **template placeholder whitelist**, and
gate the assertion within strict tolerance. Outcomes: `verified` · `mismatched` · `unsupported` ·
`unevidenced` · `dropped` (with reason). Null facts are not renderable → `unsupported`. Recommendations
must cite ≥1 `verified` fact. Drives the single combined repair round (D-5).

### Assembly (`lib/reports/assemble.ts`)

Pure. Orders surviving claims into the fixed section skeleton (Summary · Key metrics · What changed ·
Watch-outs · Recommendations) by `severity`, resolves template placeholders from the **engine** fact
values (so the published number is always the engine's), freezes `factValue` onto each claim, and emits
the honest minimal-report body when zero claims survive. Deterministic from the persisted `ReportClaim`s
(enables write-only retry without an AI call).

### Notion client write path (`lib/notion/notion-client.ts`, extended)

Adds `createPage`, `appendBlockChildren`, `listBlockChildren`, `deleteBlock` to the existing read-only,
rate-limited, backoff-wrapped client. Read methods (M2/M3) are untouched.

### Report writer (`lib/notion/report-writer.ts`)

Idempotent managed-region write: delete `Report.ownedBlockIds` → insert sentinel-wrapped managed region →
return the new block IDs. Records each block id as it creates it. **Partial-write cleanup is best-effort
using recorded IDs; the sentinel blocks aid future reconciliation** — after a hard process kill between
Notion accepting blocks and the IDs being persisted, orphan blocks are possible and not guaranteed to be
cleaned (reconciled on a later run via the sentinels). No guarantee of zero orphans across hard kills.

### Data access (`lib/data/reports.ts`)

Tenant-scoped (`workspaceId` on every call): create/find-active `ReportRun` (single-flight), persist
`ReportClaim`s, set run status/results, upsert the managed `Report` pointer, read run status for the GET
route.

### Jobs (`lib/jobs/`)

`run-report.ts` — pure orchestrator `runReport(deps, reportRunId)` with the status lifecycle.
`report-queue.ts` — queue + `enqueueReport`. `worker.ts` — `buildReportDeps()` wiring + a `failed`-recovery
handler that flips a stuck `running` run to `failed` (idempotent), same as M3.

### Contracts (`lib/contracts/report.ts`)

zod schemas shared across job, verifier, and API (see §5).

### API (`app/api/report/`)

`route.ts` — `POST` trigger. `runs/[id]/route.ts` — `GET` run status (Next.js 16: `params` is a Promise).

### UI (`/app/scan` or a report surface)

A "Generate AI Business Review" CTA + run-status display, reusing the existing scan/snapshot view-model
helpers.

---

## 5. Contracts (`lib/contracts/report.ts`)

```ts
// Computed via M3 primitives (count/sum/avg/min/max/groupBy/bucketByTime) — fact and verifier
// share this exact path. Not the deferred resolveNamedMetric min/max/groupBy wiring.
MetricRequestSpec = {
  metric: 'count' | 'sum' | 'average' | 'min' | 'max'
  sourceDatabaseId?: string
  measureFieldIds?: string[]
  classification?: string
  groupByDimensionId?: string               // optional single low-cardinality dimension
  timeGranularity?: 'day' | 'week' | 'month'
}

Fact = {
  factId: string                            // deterministic hash(canonical metricRequest + snapshotVersion)
  metricRequest: MetricRequestSpec
  label: string                             // "Sum of Amount by Region"
  value: number | null                      // null = unsupported/empty -> not renderable
  groups?: { key: string; value: number }[] // groupBy result, ranked + capped
  previousValue?: number
  delta?: { absolute: number; relative: number }
  snapshotVersion: number
  computedAt: string                        // ISO
}
FactSheet = { snapshotVersion: number; generatedAt: string; facts: Fact[] }

ClaimAssertion =
  | { kind: 'value';    factId: string; expected: number }
  | { kind: 'trend';    factId: string; expectedDelta?: { absolute?: number; relative?: number }; direction?: 'up' | 'down' | 'flat' }
  | { kind: 'rank';     factId: string; groupKey: string; position: 'max' | 'min' }
  | { kind: 'citation'; factIds: string[] } // no numeric assertion; >=1 cited fact must be verified

InsightClaim = {                            // raw AI output
  section: 'summary' | 'metric' | 'trend' | 'warning' | 'recommendation'
  template: string                          // placeholders only from the whitelist below
  assertion: ClaimAssertion
  severity?: 'low' | 'med' | 'high'
}

VerifiedClaim = InsightClaim & {
  verificationStatus: 'verified' | 'mismatched' | 'unsupported' | 'unevidenced' | 'dropped'
  reason?: string
  fact?: Fact                               // recomputed fact, for rendering + frozen audit
}
```

**Template placeholder whitelist (deterministic validator, runs in the verify pass):**

- Allowed: `{value}` `{previousValue}` `{delta.absolute}` `{delta.relative}` `{groupKey}`
- Unknown placeholder → malformed → repair-or-drop (blocks the AI injecting an unverified literal)
- `citation` template containing any number-placeholder → malformed → drop
- `trend` on a fact with no `previousValue` (no prior snapshot) → unsupported → drop
- `rank`: `{value}` resolves to the value of `groupKey` within `fact.groups`, `{groupKey}` to the key
- Any claim whose template uses a placeholder its fact can't resolve → unsupported → drop

The rendered number always comes from the engine fact, never the AI's `expected` (which is used only to
gate). A within-tolerance-but-imperfect AI guess still publishes the engine's exact figure.

---

## 6. Data model (Prisma, additive migration `0005`)

```prisma
model Report {                 // one per workspace: the current managed destination
  id                String   @id @default(cuid())
  workspaceId       String   @unique
  notionPageId      String
  ownedBlockIds     String[]                 // authoritative delete list for the managed region
  lastRunId         String?
  lastSnapshotVersion Int?
  lastGeneratedAt   DateTime?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  workspace         Workspace @relation(fields: [workspaceId], references: [id])
  @@index([workspaceId])
}

model ReportRun {              // append-only generation history
  id              String   @id @default(cuid())
  workspaceId     String
  status          String   @default("queued") // queued|running|committed|write_failed|failed
  snapshotVersion Int?
  model           String?
  promptVersion   String?
  inputTokens     Int?
  outputTokens    Int?
  results         Json?                        // { factsConsidered, claimsProposed, claimsVerified, claimsDropped[], empty }
  error           String?
  startedAt       DateTime?
  finishedAt      DateTime?
  createdAt       DateTime @default(now())
  claims          ReportClaim[]
  workspace       Workspace @relation(fields: [workspaceId], references: [id])
  @@index([workspaceId])
}

model ReportClaim {            // verifier audit trail; frozen fact values
  id                 String   @id @default(cuid())
  reportRunId        String
  workspaceId        String
  section            String
  kind               String                    // assertion kind: value|trend|rank|citation
  severity           String?
  template           String
  renderedText       String?                   // engine numbers interpolated (verified claims)
  factId             String?
  factValue          Json?                     // frozen scalar/group value at write time
  factSnapshot       Json?                     // frozen fact (request + value + delta + snapshotVersion)
  verificationStatus String                    // verified|mismatched|unsupported|unevidenced|dropped
  reason             String?
  createdAt          DateTime @default(now())
  run                ReportRun @relation(fields: [reportRunId], references: [id])
  @@index([reportRunId])
  @@index([workspaceId])
}
```

Plus a **partial unique index** (raw SQL in the migration — not expressible in the Prisma DSL, same as
M3's single-flight index):

```sql
CREATE UNIQUE INDEX "ReportRun_workspaceId_active_key"
  ON "ReportRun"("workspaceId") WHERE "status" IN ('queued', 'running');
```

`Workspace` gains the back-relations (`Report?`, `ReportRun[]`).

---

## 7. Data flow & state machine

```
POST /api/report ─▶ create/find-active ReportRun ─▶ enqueue (if created) ─▶ 202 {reportRunId}
                                                          │
                                worker: runReport(deps, reportRunId)
                                                          ▼
 1. loadRun → status running (markStarted)
 2. load current snapshot (M3) + approved mappings
       └─ none → failed ("no snapshot data"), no claims
 3. fact-sheet: enumerate → rank → bound; compute value + previous-snapshot delta   (deterministic)
 4. insight agent: facts → InsightClaim[]                                           (one AI call)
 5. verify (combined parse + verify) → one repair round (D-5) → VerifiedClaim[]      (deterministic)
 6. assemble: order by severity, interpolate engine numbers, freeze values;
       zero verified → honest minimal body                                          (deterministic)
 7. PERSIST ReportRun results + token usage + all ReportClaims                       (audit durable here)
 8. report-writer: delete ownedBlockIds → insert sentinel-wrapped managed region
       └─ write fails → write_failed (claims persisted, old report stays live, write-only retry)
 9. write OK → upsert Report (ownedBlockIds, lastRunId, lastSnapshotVersion, lastGeneratedAt) → committed
```

```
ReportRun:  queued ─▶ running ─┬─▶ committed     (claims persisted + Notion write OK; incl. honest-fallback)
                               ├─▶ write_failed  (claims persisted; Notion write failed — write-only retry)
                               └─▶ failed         (pre-persistence failure)
```

**Write-only retry:** replays only steps 8–9 from the persisted `ReportClaim`s (assembly is deterministic
from them) — no AI call. A fresh analysis is a new `ReportRun`.

---

## 8. API surface

- `POST /api/report` — same-origin + Clerk auth + workspace resolve + single-flight → `202 {reportRunId}`.
  Enqueues only a newly created run (existing in-flight run returned without re-enqueue), same as M3.
- `GET /api/report/runs/[id]` — run status + `results`; resolves the run **and asserts `workspaceId`
  match** (no cross-tenant id enumeration). Next.js 16: `await params`.

---

## 9. Security (OWASP-aligned)

- **A01 access control:** every `lib/data/reports.ts` call carries `workspaceId`; the GET route asserts
  ownership; single-flight prevents conflicting writes.
- **A02 crypto:** Notion token decrypted only in the worker (M1 AES-GCM pattern); never logged.
- **A03 injection:** Prisma parameterized; zod-validate every API and AI-output boundary; the template
  placeholder whitelist blocks unverified literals reaching Notion.
- **A04 insecure design:** AI never computes numbers; the deterministic verifier gates claims; honest
  zero-verified fallback never fabricates.
- **A09 logging:** structured logs carry **counts, IDs, statuses, and error codes only — never fact
  contents** (facts may contain business data) and never secrets/PII.
- **A10 SSRF:** outbound calls are to the Notion API only, via the existing client.

---

## 10. Testing strategy (TDD)

- **Pure units (bulk of coverage, no network):**
  - `fact-sheet`: enumeration, ranking, cardinality bounding, delta math, no-previous → trends absent,
    `factId` determinism.
  - `verifier`: each assertion kind; tolerance edges; null-fact → unsupported; placeholder-whitelist
    rejection; recommendation must cite a verified fact; combined repair pass.
  - `assemble`: section ordering by severity, engine-number interpolation, honest zero-verified fallback,
    frozen `factValue`, determinism (write-only retry).
- **Insight agent** (`ToolCaller` injected): valid output parses; one malformed → repair round;
  repair-still-bad → dropped (mirrors `schema-mapper` tests).
- **Notion writer** (mocked client): idempotent delete-owned-then-insert; only `ownedBlockIds` deleted;
  sentinel blocks present but non-authoritative; best-effort partial-write cleanup.
- **Job `runReport`** (fake deps): full lifecycle → `committed`; write throw → `write_failed` with claims
  persisted; pre-persist throw → `failed`; single-flight (second concurrent → existing run, no
  double-enqueue).
- **API routes:** same-origin/auth/workspace guards; `202 {reportRunId}`; GET run status workspace-scoped
  (cross-tenant id → no leak).
- **Contracts:** zod round-trips for `report.ts`; offline `Prisma.ModelName` includes
  `Report`/`ReportRun`/`ReportClaim`.
- **One integration slice:** seeded snapshot → `runReport` with a stubbed `ToolCaller` returning canned
  claims → assert verified claims persisted + the mocked Notion write payload is well-formed.

Gate: `typecheck && lint && test && build` green before PR. Golden-dataset AI evals for insight/verifier
quality are an **M7** item.

---

## 11. New dependencies & secrets

None beyond what exists. `@anthropic-ai/sdk` and `ANTHROPIC_API_KEY` are already present (M2); BullMQ,
Redis, Prisma, Clerk all in place. No new env vars.

---

## 12. Build sequence (for the plan)

1. Contracts (`lib/contracts/report.ts`) + zod tests.
2. Prisma models + migration `0005` (incl. raw-SQL partial unique index) + offline schema test.
3. Fact sheet (`lib/reports/fact-sheet.ts`) — pure, ranked, bounded, delta math.
4. Verifier (`lib/reports/verifier.ts`) — pure, all assertion kinds, placeholder whitelist, repair pass.
5. Assembly (`lib/reports/assemble.ts`) — pure, ordering, interpolation, fallback.
6. Insight agent (`lib/agents/insight.ts`) — `ToolCaller`, prompt, validation, repair.
7. Notion client write methods + report writer — idempotent managed region.
8. Data access (`lib/data/reports.ts`) — tenant-scoped, single-flight.
9. Job orchestrator + queue + worker wiring + `failed`-recovery handler.
10. API routes (POST trigger, GET run status) + same-origin/auth/tenant guards.
11. UI CTA + run status.
12. Integration slice; full gate green.

---

## 13. Open questions / risks

- **Salience ranking quality.** The fact-sheet ranking heuristic determines what the AI sees first; a weak
  heuristic yields bland reports. Start simple (rank by delta magnitude, then group spread, then measure
  presence); revisit with the M7 golden-dataset evals.
- **Notion managed-region reconciliation after hard kills.** `ownedBlockIds` + sentinels make cleanup
  best-effort, not guaranteed. A reconcile-on-next-run pass (delete any blocks between sentinels not in
  `ownedBlockIds`) is a candidate M7 hardening item, shared in spirit with the M3 commit/setStatus race.
- **Report destination flexibility.** Auto-create-only in M4; a "change report destination" setting is
  deferred. If users connect with no accessible parent page, first-run page creation location must be
  validated against the integration's granted access.
- **`setReportRunStatus` tenant scoping.** Mirror the M3 M7 follow-up: thread `workspaceId` into status
  writes (`updateMany({ where: { id, workspaceId } })`) rather than id-alone, even though only trusted
  worker callers reach it.
