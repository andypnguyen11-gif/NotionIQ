<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

# NotionIQ project guide

AI business analyst for Notion **+** token-gated, filterable charts embedded in Notion pages.

> **Next.js version:** This repo uses Next.js 16.x with breaking changes vs. older versions. Before
> writing any route handler, middleware, layout, or server-component code, read the relevant guide in
> `node_modules/next/dist/docs/` — do not assume older App Router APIs.

## Sources of truth (read before changing related code)

- Design spec: `docs/superpowers/specs/2026-06-05-notioniq-mvp-design.md`
- Roadmap: `Plans/00-ROADMAP.md`
- Per-milestone plans: `Plans/0X-*.md`

## Engineering principles — every change must be scalable, secure, maintainable

**Maintainable**

- Small, focused files with one responsibility; split when a file grows unwieldy.
- Shared zod contracts live in `lib/contracts/` and are imported by both API and embed.
- Follow existing patterns; don't restructure unrelated code.

**Scalable**

- Chart/filter reads hit the stored snapshot (`NormalizedRecord`), **never** live Notion per interaction.
- Redis-cache aggregations with deterministic keys: `chartId:workspaceId:normalizedFilterSet:snapshotVersion`.
- Heavy/async work (scans, AI, reports, scheduled refresh) runs on BullMQ workers.
- External API calls are paginated with backoff; respect Notion's ~3 req/s limit.

**Secure — treat every change against the OWASP Top 10**

- **A01 Broken Access Control:** mandatory tenant scoping — no data access without a `workspaceId`; verify record ownership on every query; Postgres RLS is a hardening goal.
- **A02 Cryptographic Failures:** Notion tokens encrypted at rest (AES-GCM, key in a secret manager); durable embed tokens stored only as a SHA-256 hash; never log secrets.
- **A03 Injection:** Prisma parameterized queries only; zod-validate **every** API and embed input boundary.
- **A04 Insecure Design:** AI never computes numbers (analytics engine is the source of truth); the verifier gates claims; the embed/iframe never receives the Notion token.
- **A05 Security Misconfiguration:** strict CSP `frame-ancestors` for embeds; least-privilege env; no debug output in prod.
- **A07 Auth Failures:** Clerk for app auth; embeds use a durable opaque token exchanged for a short-lived (≤120s) JWT access token; tokens are rotatable and revocable.
- **A08 Software/Data Integrity:** verify Stripe and Notion webhook signatures.
- **A09 Logging/Monitoring:** structured logs + audit trail for token mint/exchange/revoke; never log PII or secrets.
- **A10 SSRF:** validate/allowlist any outbound URLs (embeds, link previews).

## Secrets — never commit them

- **Never hardcode or commit secrets** (API keys, tokens, client secrets, DB passwords, signing keys, webhook secrets) in source, tests, fixtures, config, or docs. No exceptions.
- Read every secret from the environment via `lib/env.ts` (`getEnv()`); add new ones to the zod schema and to `.env.example` with a **placeholder** value only.
- Real values live in untracked `.env` (gitignored) locally and in the host's secret manager / encrypted CI secrets in deploy (Vercel/GitHub Actions secrets). The Notion OAuth token is additionally encrypted at rest (AES-GCM) — see A02.
- If a secret is ever committed, treat it as compromised: rotate it immediately, then scrub history.
- The only key-shaped strings allowed in the repo are obvious **non-functional placeholders** (e.g. Clerk's `pk_test_Y2xlcmsuZXhhbXBsZS5jb20k` build dummy). Never a working credential.

## Testing — non-negotiable

- **TDD:** write a failing test → run it and watch it fail → minimal implementation → run it and watch it pass.
- **Every PR/change includes tests** for the behavior it adds or fixes. No untested logic merges.
- Before opening a PR, all of these must pass: `npm run typecheck && npm run lint && npm run test && npm run build`.

## Commits & branches

- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `test:`, `refactor:`.
- **Do NOT put PR numbers or task numbers in commit messages or subjects.** Describe the change itself.
- One logical change per commit; keep the working tree clean.
- Co-author line on each commit:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Branch per milestone/feature (e.g. `m0-foundation`); **never build directly on `main`.**

## Local commands

- `npm run dev` — app at http://localhost:3000
- `npm run typecheck` · `npm run lint` · `npm run test` · `npm run build`
- Env is validated via `lib/env.ts` (`getEnv()`); copy `.env.example` to `.env`.
