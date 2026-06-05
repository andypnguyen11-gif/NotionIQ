# NotionIQ MVP — Implementation Roadmap

> **For agentic workers:** Each milestone below has (or will have) its own plan file in this folder.
> Implement plans **in order** — later milestones depend on earlier ones. Use
> `superpowers:subagent-driven-development` or `superpowers:executing-plans` to run each plan
> task-by-task.

**Source spec:** `docs/superpowers/specs/2026-06-05-notioniq-mvp-design.md`

**Goal:** Ship the full NotionIQ MVP — an AI business analyst inside Notion that also delivers
token-gated, filterable chart widgets embedded in Notion pages.

---

## Tech stack (locked for all milestones)

- **App:** Next.js (App Router) + TypeScript + Tailwind + shadcn/ui
- **DB:** Postgres (Neon) + Prisma
- **Auth:** Clerk
- **Jobs/cache:** BullMQ + Redis (Upstash)
- **AI:** Claude API (`@anthropic-ai/sdk`) via isolated agents
- **Charts:** Recharts (decision finalized in M5) rendered in a token-gated embed route
- **Validation:** zod (shared contracts between API and embed)
- **Billing:** Stripe
- **Tests:** Vitest (unit/integration), Playwright (e2e), golden-dataset AI evals
- **CI:** GitHub Actions → Vercel

---

## Milestone → plan map

| # | Milestone | Plan file | Depends on | Produces (working, testable) |
|---|-----------|-----------|------------|------------------------------|
| M0 | Foundation | `01-foundation.md` | — | Running app, typed env, Prisma client, health check, Clerk-protected routes, CI |
| M1 | Notion connect | `02-notion-connect.md` | M0 | OAuth connect/disconnect, AES-GCM encrypted token at rest |
| M2 | Understand workspace | `03-scanner-schema-mapper.md` | M1 | Scanner + AI schema mapper + human-in-the-loop mapping review |
| M3 | Truth layer | `04-analytics-truth-layer.md` | M2 | Analytics engine + `NormalizedRecord` + metric snapshots + `snapshotVersion` |
| M4 | Reports | `05-insight-verifier-report-writer.md` | M3 | Insight agent + verifier + Notion text-report writer |
| M5 | Charts | `06-charts-embed-filters.md` | M4 | chart-builder, filter-engine (cardinality-guarded), snapshot-query, embed route, embed-auth, versioned contract, embed-block insertion |
| M6 | Business | `07-billing-scheduling-observability.md` | M4 (M5 for chart gating) | Stripe billing + entitlements gating + scheduled refresh + observability |
| M7 | Hardening | `08-hardening.md` | M0–M6 | Security review, RLS+pooling validation, AI evals, load test |

---

## Build-order rationale

- M0–M4 are a strict dependency chain: you cannot chart data you haven't normalized (M3), and you
  cannot normalize data from a workspace you haven't scanned (M2) or connected (M1).
- **M5 (Charts)** is the differentiator but sits on top of the truth layer — it is deliberately not
  first, because filterable charts are meaningless without `NormalizedRecord` + `snapshotVersion`
  from M3.
- **M6** can begin once M4 exists (text reports are sellable), but chart-tier gating needs M5.
- **M7** is cross-cutting hardening run last, including the RLS-vs-pooling validation flagged in the
  spec's open questions.

---

## Cross-cutting conventions (apply in every plan)

- **TDD:** failing test → run (see it fail) → minimal impl → run (see it pass) → commit.
- **Tenant scoping is mandatory** (spec ADR-3): no data-access call without a `workspaceId`.
- **Shared zod contracts** live in `lib/contracts/` and are imported by both API and embed.
- **Frequent commits** — one per task, conventional-commit messages.
- **No secrets in the iframe** — the embed route never touches the Notion token (spec ADR-1/ADR-2).

---

## Dependency, secrets & cost map (so JIT planning doesn't blindside earlier milestones)

| Concern | Detail | First needed |
|---------|--------|--------------|
| **External services** | Neon (Postgres), Upstash (Redis), Clerk, Notion OAuth app, Anthropic API, Stripe, Vercel, PostHog, Sentry | Neon+Clerk: M0 · Notion: M1 · Anthropic: M2 · Redis: M5 (aggregation cache) · Stripe: M6 |
| **Secrets** | `DATABASE_URL`, `CLERK_*`, `NOTION_OAUTH_CLIENT_ID/SECRET`, `NOTION_REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY` (AES-GCM), `EMBED_JWT_SIGNING_KEY`, `ANTHROPIC_API_KEY`, `REDIS_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `POSTHOG_KEY`, `SENTRY_DSN` | added to `lib/env.ts` at the milestone that first uses them |
| **Migrations** | Prisma migrations are additive per milestone; `Workspace.snapshotVersion` and `NormalizedRecord` land in M3; `Chart`/`ChartFilter`/`EmbedToken` in M5. No destructive migrations assumed. | M0 establishes the migration baseline |
| **Cost-sensitive** | Anthropic token usage (insight/verifier — cache prompts, batch where possible), Notion API calls (paginated + snapshot-cached, never per-filter), Redis aggregation cache (bounded by cardinality caps) | M2/M3/M5 |
| **Decisions that must not be re-litigated later** | snapshot-not-live filtering (ADR-1), opaque-token-not-JWT for durable embed token (ADR-2), mandatory query-layer tenant scoping (ADR-3) | locked in spec |

---

## Reproducibility baseline (for future sessions)

To trust this baseline, a future session should verify:

- `git status` is clean (no uncommitted drift).
- Baseline commits exist: initial docs, roadmap + M0 plan, and the review-hardening pass.
- Re-read the three source-of-truth docs in one command:
  ```bash
  cat docs/superpowers/specs/2026-06-05-notioniq-mvp-design.md Plans/00-ROADMAP.md Plans/01-foundation.md
  ```

---

## Status

- [x] Roadmap
- [ ] M0 Foundation (`01-foundation.md`) — **written, ready to execute**
- [ ] M1 Notion connect — not yet written
- [ ] M2 Scanner + schema mapper — not yet written
- [ ] M3 Truth layer — not yet written
- [ ] M4 Reports — not yet written
- [ ] M5 Charts — not yet written
- [ ] M6 Business — not yet written
- [ ] M7 Hardening — not yet written

> Subsequent milestone plans are written just-in-time (right before execution) so they reflect the
> actual code that exists, rather than going stale against drift.
