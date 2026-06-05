# M0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a running, typed, tested Next.js app with a validated environment, a Prisma client, a health endpoint, Clerk-protected routes, and CI — the substrate every later milestone builds on.

**Architecture:** Next.js App Router + TypeScript. Configuration is validated once at boot through a zod schema (`lib/env.ts`) so missing/typo'd env vars fail fast. Prisma is exposed as a single cached client to avoid connection exhaustion in dev. Clerk middleware gates `/app/*` routes. GitHub Actions runs typecheck + tests + build on every push.

**Tech Stack:** Next.js, TypeScript, Tailwind, shadcn/ui, Prisma, Postgres (Neon), Clerk, zod, Vitest, GitHub Actions.

---

## File structure (created in this milestone)

- `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts` — project config
- `vitest.config.ts` — test runner config
- `lib/env.ts` — zod-validated environment (owns: config validation)
- `lib/env.test.ts`
- `lib/prisma.ts` — cached Prisma client (owns: DB client lifecycle)
- `lib/prisma.test.ts`
- `prisma/schema.prisma` — initial datasource + generator (no models yet)
- `app/api/health/route.ts` — liveness endpoint (owns: health reporting)
- `app/api/health/route.test.ts`
- `app/layout.tsx`, `app/page.tsx` — marketing root
- `app/(app)/layout.tsx` — protected app shell
- `middleware.ts` — Clerk route protection
- `.github/workflows/ci.yml` — CI pipeline
- `.env.example` — documented env contract

---

## Task 1: Scaffold the project

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `app/layout.tsx`, `app/page.tsx`, `vitest.config.ts`

- [ ] **Step 1: Scaffold Next.js with TypeScript + Tailwind**

Run (non-interactive):
```bash
npx create-next-app@latest . --ts --tailwind --app --src-dir=false --import-alias "@/*" --no-eslint --use-npm --yes
```
Expected: project files generated in the current directory.

- [ ] **Step 2: Add test + validation dependencies**

Run:
```bash
npm install zod && npm install -D vitest @vitejs/plugin-react vite-tsconfig-paths
```
Expected: dependencies added to `package.json`.

- [ ] **Step 3: Configure Vitest**

Create `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    globals: true,
    include: ['**/*.test.ts', '**/*.test.tsx'],
  },
})
```

- [ ] **Step 4: Add test + typecheck scripts**

In `package.json`, add to `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest",
"typecheck": "tsc --noEmit"
```

- [ ] **Step 5: Verify the app builds and the test runner works**

Run:
```bash
npm run typecheck && npx vitest run --passWithNoTests
```
Expected: typecheck passes; Vitest reports "no test files found" but exits 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold next.js app with vitest and zod"
```

---

## Task 2: Typed environment validation

**Files:**
- Create: `lib/env.ts`
- Test: `lib/env.test.ts`
- Create: `.env.example`

- [ ] **Step 1: Write the failing test**

Create `lib/env.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseEnv } from './env'

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
}

describe('parseEnv', () => {
  it('returns a typed config when required vars are present', () => {
    const env = parseEnv(valid)
    expect(env.DATABASE_URL).toBe(valid.DATABASE_URL)
    expect(env.NEXT_PUBLIC_APP_URL).toBe(valid.NEXT_PUBLIC_APP_URL)
  })

  it('throws when a required var is missing', () => {
    expect(() => parseEnv({ NEXT_PUBLIC_APP_URL: 'http://localhost:3000' })).toThrow(/DATABASE_URL/)
  })

  it('throws when a URL var is malformed', () => {
    expect(() => parseEnv({ ...valid, NEXT_PUBLIC_APP_URL: 'not-a-url' })).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/env.test.ts`
Expected: FAIL — `parseEnv` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `lib/env.ts`:
```ts
import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  NEXT_PUBLIC_APP_URL: z.string().url(),
})

export type Env = z.infer<typeof envSchema>

export function parseEnv(input: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid environment: ${issues}`)
  }
  return parsed.data
}

// Lazy: do NOT parse at import time (keeps tests and tooling from throwing on a
// partially-populated env). App code calls getEnv() at request/boot time.
let cached: Env | undefined
export function getEnv(): Env {
  if (!cached) cached = parseEnv(process.env)
  return cached
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/env.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Document the env contract**

Create `.env.example`:
```
DATABASE_URL="postgresql://user:pass@localhost:5432/notioniq"
NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

- [ ] **Step 6: Commit**

```bash
git add lib/env.ts lib/env.test.ts .env.example
git commit -m "feat: add zod-validated environment config"
```

---

## Task 3: Prisma client singleton

**Files:**
- Create: `prisma/schema.prisma`, `lib/prisma.ts`
- Test: `lib/prisma.test.ts`

- [ ] **Step 1: Initialize Prisma**

Run:
```bash
npm install -D prisma && npm install @prisma/client && npx prisma init --datasource-provider postgresql && npx prisma generate
```
Expected: `prisma/schema.prisma` and a `.env` with `DATABASE_URL` created, and the (empty-model) client generated so `@prisma/client` is importable in tests.

- [ ] **Step 2: Write the failing test**

Create `lib/prisma.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { createPrismaSingleton } from './prisma'

describe('createPrismaSingleton', () => {
  it('returns the same instance across calls (caches on the provided global ref)', () => {
    const globalRef: { prisma?: unknown } = {}
    const factory = () => ({ id: Math.random() })
    const a = createPrismaSingleton(globalRef, factory)
    const b = createPrismaSingleton(globalRef, factory)
    expect(a).toBe(b)
  })

  it('builds a new instance when the global ref is empty', () => {
    const globalRef: { prisma?: unknown } = {}
    const instance = createPrismaSingleton(globalRef, () => ({ id: 1 }))
    expect(instance).toBeDefined()
    expect(globalRef.prisma).toBe(instance)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run lib/prisma.test.ts`
Expected: FAIL — `createPrismaSingleton` not exported.

- [ ] **Step 4: Write minimal implementation**

Create `lib/prisma.ts`:
```ts
import { PrismaClient } from '@prisma/client'

export function createPrismaSingleton<T>(
  globalRef: { prisma?: T },
  factory: () => T,
): T {
  if (!globalRef.prisma) {
    globalRef.prisma = factory()
  }
  return globalRef.prisma
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

// Lazy: do NOT construct PrismaClient at import time. App code calls getPrisma()
// at request time; the unit test exercises createPrismaSingleton with a fake factory.
export function getPrisma(): PrismaClient {
  return createPrismaSingleton(globalForPrisma, () => new PrismaClient())
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/prisma.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Generate the client and commit**

Run:
```bash
npx prisma generate
git add prisma/schema.prisma lib/prisma.ts lib/prisma.test.ts
git commit -m "feat: add cached prisma client singleton"
```
Expected: client generates; commit succeeds.

---

## Task 4: Health check endpoint

**Files:**
- Create: `app/api/health/route.ts`
- Test: `app/api/health/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/api/health/route.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { GET } from './route'

describe('GET /api/health', () => {
  it('returns 200 with status ok', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(typeof body.timestamp).toBe('string')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/api/health/route.test.ts`
Expected: FAIL — `./route` not found.

- [ ] **Step 3: Write minimal implementation**

Create `app/api/health/route.ts`:
```ts
import { NextResponse } from 'next/server'

export function GET() {
  return NextResponse.json({ status: 'ok', timestamp: new Date().toISOString() })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/api/health/route.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add app/api/health/route.ts app/api/health/route.test.ts
git commit -m "feat: add /api/health liveness endpoint"
```

---

## Task 5: Clerk auth + protected app shell

**Files:**
- Create: `middleware.ts`, `app/(app)/layout.tsx`
- Modify: `app/layout.tsx` (wrap in `<ClerkProvider>`), `lib/env.ts` (add Clerk keys), `.env.example`

- [ ] **Step 1: Install Clerk**

Run:
```bash
npm install @clerk/nextjs
```

- [ ] **Step 2: Extend the env schema for Clerk (test first)**

Add to `lib/env.test.ts` inside the `describe('parseEnv'...)` block:
```ts
  it('requires Clerk keys', () => {
    expect(() => parseEnv({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    })).toThrow(/CLERK/)
  })
```
And update the `valid` fixture at the top of the file to include:
```ts
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x',
  CLERK_SECRET_KEY: 'sk_test_x',
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run lib/env.test.ts`
Expected: FAIL — the new `requires Clerk keys` test fails (keys not yet in schema).

- [ ] **Step 4: Add Clerk keys to the env schema**

In `lib/env.ts`, add to `envSchema`:
```ts
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1, 'CLERK publishable key is required'),
  CLERK_SECRET_KEY: z.string().min(1, 'CLERK secret key is required'),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/env.test.ts`
Expected: PASS (all env tests).

- [ ] **Step 6: Add Clerk middleware**

Create `middleware.ts`:
```ts
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

const isProtected = createRouteMatcher(['/app(.*)'])

export default clerkMiddleware(async (auth, req) => {
  if (isProtected(req)) {
    await auth.protect()
  }
})

export const config = {
  matcher: ['/((?!_next|.*\\..*).*)', '/(api|trpc)(.*)'],
}
```

- [ ] **Step 7: Wrap the root layout in ClerkProvider**

In `app/layout.tsx`, import and wrap the existing `<html>...</html>` tree:
```tsx
import { ClerkProvider } from '@clerk/nextjs'
// ...inside the default export's return, wrap the root element:
//   return <ClerkProvider><html lang="en"><body>{children}</body></html></ClerkProvider>
```

- [ ] **Step 8: Create the protected app shell**

Create `app/(app)/layout.tsx`:
```tsx
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen">{children}</div>
}
```

- [ ] **Step 9: Document the new env vars**

Append to `.env.example`:
```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_test_xxx"
CLERK_SECRET_KEY="sk_test_xxx"
```

- [ ] **Step 10: Verify typecheck + tests pass, then commit**

Run:
```bash
npm run typecheck && npx vitest run
```
Expected: typecheck passes; all tests pass.
```bash
git add -A
git commit -m "feat: add clerk auth with protected /app routes"
```

---

## Task 6: CI pipeline

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    env:
      DATABASE_URL: postgresql://user:pass@localhost:5432/db
      NEXT_PUBLIC_APP_URL: http://localhost:3000
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: pk_test_x
      CLERK_SECRET_KEY: sk_test_x
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx prisma generate
      - run: npm run typecheck
      - run: npm run test
      - run: npm run build
```

- [ ] **Step 2: Verify the steps pass locally (CI parity check)**

Run:
```bash
npm run typecheck && npm run test && npm run build
```
Expected: all three succeed locally (proves the CI steps will pass).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add typecheck, test, and build pipeline"
```

---

## Definition of done (M0)

- `npm run typecheck`, `npm run test`, and `npm run build` all pass.
- `GET /api/health` returns `{ status: 'ok', timestamp }`.
- Missing/invalid env vars throw a clear error at boot (`parseEnv`).
- `/app/*` routes require authentication; the marketing root is public.
- CI runs the same checks on every push/PR.
