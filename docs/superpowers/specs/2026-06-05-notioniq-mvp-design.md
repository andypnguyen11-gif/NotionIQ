# NotionIQ — MVP Design Spec

- **Status:** Draft for approval
- **Date:** 2026-06-05
- **Supersedes/Amends:** `PRD.md` (the "no charts / no dashboards" exclusions), `Architecture.md` (adds the charts + embed subsystem)
- **Scope:** Full MVP, sequenced into milestones (built in order, not phased-out of scope)

---

## 1. Summary

NotionIQ remains an **AI business analyst that lives inside Notion** — it connects a user's
Notion workspace, computes facts with a deterministic analytics engine, and writes AI-interpreted
business reports back into Notion. This spec **adds an embedded interactive analytics layer** as the
paid differentiator: **filterable chart widgets** the app builds and inserts into the Notion report
page as `embed` blocks, so users see and filter analytics **without leaving Notion**.

This amends the PRD's "no charts ever" stance while staying true to its spirit: we are not reselling
Notion's native charts, we are shipping interactive analytics — served from our own truth layer —
that Notion cannot do natively. That is what makes the paid tier defensible.

### Core principle (unchanged from PRD)

> Notion = system of record · Analytics Engine = truth · AI = interpretation · Verifier = safety · Human = final approval.

The analytics engine never lets the AI compute numbers; the AI only interprets verified facts.

---

## 2. Product shape

| Tier | Includes |
|------|----------|
| **Free** | 1 manual AI text report · **1 embedded chart, non-filterable** · manual refresh |
| **Pro ($10–15/mo)** | Unlimited **filterable** charts · saved/custom filters · scheduled refresh (default every 24h) · business memory · advanced insights |

A free non-filterable chart runs the **same** embed + token pipeline as a Pro chart, with filters
disabled. No special-case free renderer — one code path, gated by entitlements.

---

## 3. Architecture decisions (ADRs)

### ADR-1 — Filters query a stored snapshot, never live Notion
Filters aggregate against a row-level `NormalizedRecord` table in Postgres (written by the
scanner/analytics engine), cached in Redis — **not** the live Notion API.

- **Why:** Notion's ~3 req/s integration rate limit makes live interactive filtering slow and
  fragile, and would force the Notion token into the iframe context.
- **Tradeoff:** Data is only as fresh as the last scan. Mitigated by a **"Data last refreshed at …"**
  label in the embed UI and a refresh trigger (manual for Free, scheduled for Pro).

### ADR-2 — Embed authentication: durable scoped URL token → short-lived in-memory access token
The Notion `embed` block stores a fixed `src` URL containing a **durable, signed, revocable token**
scoped to `chartId + workspaceId` that **carries no data**. On each iframe load, the embed page
**exchanges it server-side** for a **short-lived access token held in the iframe's JS memory** (not a
cookie). All subsequent data fetches use the short-lived token.

- **Why not single-use:** A Notion embed reloads on every page open and is viewed by multiple
  workspace members; a strictly one-time token would break on the second load. The durable URL token
  is reusable but minimal, signed, and revocable; leak-resistance comes from carrying no data and
  exchanging for a short-lived token per session.
- **Why in-memory, not cookie:** Third-party iframe cookies are unreliable under SameSite/partitioning
  (CHIPS). An in-memory access token sidesteps third-party-cookie blocking.

**Token lifetimes & rotation:**
- **Exchange (access) token:** short wall-clock TTL, **60–120s**; re-minted on every iframe load.
- **Durable URL token:** a **revocable reference** (`EmbedToken` record), **not** time-expired by
  default — because the token is baked into the Notion embed `src` and is not re-minted on our
  schedule, a wall-clock TTL would silently break charts for low-activity users (especially Free,
  manual-refresh). Rotation is **on demand** — leak suspicion, workspace disconnect, or manual
  regenerate — implemented as revoke + embed-block rewrite.
- **Optional hygiene re-mint:** a 90-day re-mint MAY be piggybacked on the Pro scheduled-refresh job
  (which already rewrites report content); never a hard TTL that can orphan an embedded chart.

### ADR-3 — Tenant isolation at two layers
1. **Query-builder layer (mandatory):** every data-access path is scoped by `workspaceId`; no query
   may be issued without it. Enforced in a thin data-access module, not scattered through handlers.
2. **DB policy layer / RLS (hardening goal, conditional):** Postgres Row-Level Security scoped by
   `workspaceId` as defense-in-depth. **Conditional** because RLS requires a per-transaction
   `SET app.workspace_id`, which interacts awkwardly with transaction-mode connection pooling
   (PgBouncer/Neon). Validate the pooling story before committing; do not assume it in milestone
   planning.

### ADR-4 — Deterministic cache keys
Aggregation cache key = `chartId : workspaceId : normalizedFilterSet : snapshotVersion`.
A new scan bumps `snapshotVersion` on the workspace, so cached aggregations invalidate automatically
(new version ⇒ new key space) with no explicit cache busting.

### ADR-5 — Refresh SLA tiers (defined now)
- **Free:** manual refresh only.
- **Pro:** scheduled refresh via BullMQ, default every 24h, configurable.

### ADR-6 — Versioned chart data contract
A frozen, typed `ChartDataContract` (zod schema with a `version` field) is the only interface between
the embed and the data API, established day one so adding chart types later doesn't break embeds.

---

## 4. Charts + filtering subsystem (the new core)

### In-app vs. in-embed split
- **Filter *definitions* are configured in the main web app** (chart owner): the **Filter Engine**
  inspects each chart's mapped source fields and *suggests* filter candidates by type —
  `select/status → multi-select`, `date → range`, `number → min/max/bucket`. The owner accepts
  suggestions and can **add / remove / edit** filters per chart. ("AI-suggested + user-customizable.")
- **Filter *values* are applied inside the embed** by any page viewer: dropdowns / date pickers /
  typeaheads rendered in the iframe; changing them re-fetches a fresh aggregation.

### Filter cardinality control
The Filter Engine detects high-cardinality fields and switches them from multi-select to
**server-side typeahead** (or declines to suggest them), so the iframe never loads thousands of
options and query cost stays bounded.

### New modules (consistent with the `lib/` dependency map in Architecture.md)
- `lib/charts/chart-builder.ts` — turns a metric + approved mapping into a chart definition.
- `lib/charts/filter-engine.ts` — suggests, validates, and cardinality-guards filters from field types.
- `lib/charts/snapshot-query.ts` — applies filters + aggregates over `NormalizedRecord`; Redis-cached
  per ADR-4.
- `lib/charts/contract.ts` — the versioned `ChartDataContract` zod schemas (shared by API + embed).
- `lib/charts/embed-auth.ts` — mints/validates durable URL tokens and short-lived access tokens (ADR-2).
- `components/charts/` — chart renderer (Recharts or visx) + filter controls.
- `app/embed/charts/[chartId]/…` — the iframe page: token-gated, no app chrome.
- Report writer extended to insert `embed` blocks pointing at the signed embed URL.

### Data flow (chart path)
```
Scanner → NormalizedRecord (row-level truth, snapshotVersion N)
   → Chart definition (chart-builder) + suggested ChartFilters (filter-engine)
   → Report writer inserts embed block (src = signed URL token) into Notion page
Viewer opens Notion page
   → iframe loads → exchanges URL token for short-lived access token (embed-auth)
   → applies filter values → snapshot-query aggregates NormalizedRecord (Redis cache by ADR-4)
   → renders chart + "Data last refreshed at …"
```

---

## 5. Data model additions (Prisma)

- **`NormalizedRecord`** — row-level truth for charts: `workspaceId`, `sourceDatabaseId`,
  `mappedFields` (typed JSON), `occurredAt`, `snapshotVersion`. The thing filters aggregate over.
- **`Chart`** — `workspaceId`, `type`, `sourceMapping`, `metricRef`, `snapshotVersionAtCreate`.
- **`ChartFilter`** — `chartId`, `field`, `operator`, `source` (`ai_suggested | user_added`),
  `enabled`, `defaultValue`, `cardinalityMode` (`multiselect | typeahead`).
- **`EmbedToken`** — durable revocable URL token record: `chartId`, `workspaceId`, `revokedAt`
  (the short-lived access token is stateless/JWT, not stored).
- **Workspace** gains `snapshotVersion` (int, bumped each scan).

Plus the PRD's existing tables: User, NotionConnection, Workspace, DatabaseMapping, AnalysisRun,
Report, Insight, ActionItem.

---

## 6. Security

- **Notion token at rest:** AES-GCM encryption, key in a managed secret store / KMS; decrypt only in
  server-side scanner/analytics paths, never in the iframe.
- **Embed auth:** ADR-2 (durable signed scoped URL token → short-lived in-memory access token;
  revocable).
- **Tenant isolation:** ADR-3 (query-builder mandatory + RLS hardening goal).
- **Webhooks:** Stripe webhook signature verification.
- **Input validation:** zod at every API boundary, including the embed data API.
- **Iframe headers:** CSP `frame-ancestors` tuned to allow Notion embedding while blocking others.
- **AI guardrails (from PRD):** AI never computes numbers; every insight references data; the verifier
  gates claims before they reach a human.

---

## 7. Scalability

- Snapshot reads (ADR-1) instead of live Notion → no per-interaction API calls.
- Redis-cached aggregations with deterministic keys (ADR-4).
- BullMQ workers for scans / AI / report jobs; paginated Notion scanning with backoff.
- Neon pooled Postgres.
- Filter cardinality caps (Section 4) keep embed payloads and query cost bounded.

---

## 8. Maintainability & testing

- **Module boundaries:** the `lib/` units already mapped in Architecture.md, each independently
  testable, communicating through typed contracts.
- **Shared contracts:** zod schemas shared between API and embed (incl. `ChartDataContract`, ADR-6).
- **Isolated AI agents:** WorkspaceAnalyzer, Insight, ReportWriter — each separately testable + traced.
- **Testing strategy:**
  - Pure-function unit tests for the **metric engine** and **filter engine** (deterministic).
  - **Embed-auth** tests (token mint/exchange/expiry/revocation).
  - Mocked **contract tests** for the Notion client.
  - One **e2e** through the vertical slice (connect → scan → metric → chart → report).
  - **Golden-dataset AI evals** for insight + verifier quality.

---

## 9. Monetization gating

Enforced by the Entitlements service at the **API and job layers** (not UI alone): chart count,
filterability, saved/custom filters, scheduled refresh, and business memory are gated per Section 2.

---

## 10. Milestones (full MVP, sequenced)

- **M0 — Foundation:** Next.js/TS/Tailwind/shadcn, Prisma, Clerk auth, env handling, CI.
- **M1 — Notion connect:** OAuth, encrypted token storage, disconnect.
- **M2 — Understand workspace:** scanner + AI schema mapper + human-in-the-loop mapping review.
- **M3 — Truth layer:** analytics engine + `NormalizedRecord` + metric snapshots + `snapshotVersion`.
- **M4 — Reports:** insight agent + verifier + Notion text-report writer.
- **M5 — Charts:** chart-builder + filter-engine (+ cardinality guard) + snapshot-query + embed route +
  embed-auth + versioned contract + embed-block insertion.
- **M6 — Business:** billing/entitlements + scheduled refresh (BullMQ) + observability.
- **M7 — Hardening:** security review, RLS pooling validation, AI evals, load testing.

---

## 11. Out of scope (MVP)

Carried from PRD, **except** the charts/filtering exclusions, which this spec deliberately reverses:
no dashboard *builder*, no mobile app, no Slack/email/Sheets/Airtable/QuickBooks/Shopify integrations,
no team accounts/enterprise permissions, no auto database editing, no full workspace restructuring,
no AI chat (future).

---

## 12. Open questions / risks

- **RLS + pooling (ADR-3):** confirm Neon/PgBouncer transaction-mode compatibility before relying on RLS.
- **Embed styling fidelity:** API-created embeds can render slightly differently from manually pasted
  ones; validate the visual result inside a real Notion page early in M5.
- **Snapshot freshness expectations:** confirm the 24h default Pro refresh is acceptable for target
  users, or whether some metrics need tighter SLAs.
- **Chart library:** Recharts vs visx — decide in M5 based on filter-control ergonomics and bundle size.
