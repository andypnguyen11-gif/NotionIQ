# Auth Hardening (M1.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four agreed M1.1 hardening items on the Notion OAuth flow: structured (secret-free) logging, a `?notion=` status banner, an explicit same-origin guard on the disconnect POST, and a CI runtime bump.

**Architecture:** A tiny reusable structured logger (`lib/log.ts`) emits JSON events at the OAuth boundaries (no secrets/PII). The disconnect route handler gains an explicit Origin check mirroring Next.js's built-in Server Action CSRF defense (route handlers are NOT covered by that built-in). The `/app` page reads the async `searchParams` and renders a status banner derived by a pure, unit-tested function. CI moves to Node 22 LTS with `actions/checkout@v5` + `actions/setup-node@v5`.

**Tech Stack:** Next.js 16 (App Router route handlers + async `searchParams`), Clerk `auth()`, Vitest (environment `node` — no jsdom/RTL, so UI logic is tested as pure functions), GitHub Actions.

---

## File Structure

- `lib/log.ts` (create) — structured JSON logger; one responsibility: emit `{level, event, ...fields}`. No secrets ever.
- `lib/log.test.ts` (create) — unit tests for the logger.
- `app/api/notion/callback/route.ts` (modify) — emit connect/invalid/exchange-failed events.
- `app/api/notion/callback/route.test.ts` (modify) — assert the exchange-failed event is logged on `catch`.
- `app/api/notion/disconnect/route.ts` (modify) — add Origin guard + revoke log event.
- `app/api/notion/disconnect/route.test.ts` (modify) — cover origin accept/reject + assert no data access on reject.
- `app/app/notion-status.ts` (create) — pure `notionStatusBanner(status)` → `{tone, message} | null`.
- `app/app/notion-status.test.ts` (create) — unit tests for the pure mapping.
- `app/app/notion-status-banner.tsx` (create) — thin server component rendering the pure result.
- `app/app/page.tsx` (modify) — read async `searchParams`, render the banner.
- `.github/workflows/ci.yml` (modify) — bump actions to v5, Node 20 → 22.

---

### Task 1: Structured logger (`lib/log.ts`)

**Files:**
- Create: `lib/log.ts`
- Test: `lib/log.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/log.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { log } from './log'

afterEach(() => vi.restoreAllMocks())

describe('log', () => {
  it('emits a single JSON line with level, event, and fields to stdout for info', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.info('notion_connected', { userId: 'user_123', notionWorkspaceId: 'ws_1' })
    expect(spy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed).toMatchObject({
      level: 'info',
      event: 'notion_connected',
      userId: 'user_123',
      notionWorkspaceId: 'ws_1',
    })
  })

  it('routes error events to stderr', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    log.error('notion_oauth_exchange_failed', { userId: 'user_123' })
    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed).toMatchObject({ level: 'error', event: 'notion_oauth_exchange_failed' })
  })

  it('emits event with no fields when none are given', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.warn('notion_oauth_state_invalid')
    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed).toEqual({ level: 'warn', event: 'notion_oauth_state_invalid' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/log.test.ts`
Expected: FAIL — cannot find module `./log`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/log.ts
// Structured, secret-free application logging. Emit only non-sensitive identifiers
// (Clerk user ids, Notion workspace ids, event names) — NEVER tokens, codes, secrets, or PII.
type LogLevel = 'info' | 'warn' | 'error'
type LogFields = Record<string, string | number | boolean | null | undefined>

function emit(level: LogLevel, event: string, fields?: LogFields): void {
  const line = JSON.stringify({ level, event, ...(fields ?? {}) })
  if (level === 'error') {
    console.error(line)
  } else {
    console.log(line)
  }
}

export const log = {
  info: (event: string, fields?: LogFields) => emit('info', event, fields),
  warn: (event: string, fields?: LogFields) => emit('warn', event, fields),
  error: (event: string, fields?: LogFields) => emit('error', event, fields),
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/log.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/log.ts lib/log.test.ts
git commit -m "feat(log): add structured secret-free application logger"
```

---

### Task 2: Emit OAuth events from the callback (A09)

**Files:**
- Modify: `app/api/notion/callback/route.ts`
- Test: `app/api/notion/callback/route.test.ts`

- [ ] **Step 1: Write the failing test** — add to the existing `describe` block. The exchange-throw case already exists; add a logging assertion alongside it.

```ts
// at top of file, with the other imports
import { log } from '@/lib/log'
// in the describe block:
it('logs a secret-free exchange-failed event when the token exchange throws', async () => {
  mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
  // state + nonce set up exactly as the existing "exchange throws" test does
  const errSpy = vi.spyOn(log, 'error')
  // ...reuse the existing arrangement that makes exchangeCodeForToken reject...
  // (call GET(req) with a valid state + matching nonce cookie)
  await GET(req)
  expect(errSpy).toHaveBeenCalledWith(
    'notion_oauth_exchange_failed',
    expect.objectContaining({ userId: 'user_123' }),
  )
  // ensure no secret leaked into the log fields
  const fields = errSpy.mock.calls[0][1] as Record<string, unknown>
  expect(JSON.stringify(fields)).not.toContain('secret')
})
```

> Note: reuse the existing test's state/nonce/`req` construction verbatim (the file already builds a valid signed state, a matching nonce cookie, and a `NextRequest`). Spy on the real `log` object — do not mock the module — so the route's actual call is observed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/api/notion/callback/route.test.ts`
Expected: FAIL — `log.error` not called (route does not log yet).

- [ ] **Step 3: Add the logging calls**

Edit `app/api/notion/callback/route.ts`:

```ts
import { log } from '@/lib/log'
```

In the invalid-state branch (after `verifyState`/nonce check fails), before `return redirectToApp(appUrl, 'invalid')`:

```ts
log.warn('notion_oauth_state_invalid', { userId })
```

On success, before `return redirectToApp(appUrl, 'connected')`:

```ts
log.info('notion_connected', { userId, notionWorkspaceId: token.workspaceId })
```

In the `catch` block, before `return redirectToApp(appUrl, 'error')`:

```ts
log.error('notion_oauth_exchange_failed', { userId })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/api/notion/callback/route.test.ts`
Expected: PASS (all existing + new test).

- [ ] **Step 5: Commit**

```bash
git add app/api/notion/callback/route.ts app/api/notion/callback/route.test.ts
git commit -m "feat(notion): log secret-free oauth callback outcomes"
```

---

### Task 3: Same-origin guard on the disconnect POST (A07)

**Files:**
- Modify: `app/api/notion/disconnect/route.ts`
- Test: `app/api/notion/disconnect/route.test.ts`

Context: route handlers are NOT covered by Next.js's built-in Server Action CSRF check (which compares Origin to Host). We replicate it explicitly: reject the state-changing POST unless the `Origin` header host matches our configured app origin. A same-origin `fetch(..., { method: 'POST' })` always sends `Origin`, so requiring it is safe.

- [ ] **Step 1: Write the failing tests** — replace the existing test file body so every call passes a `NextRequest` with headers, and add the env mock.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }))
vi.mock('@/lib/env', () => ({ getEnv: () => ({ NEXT_PUBLIC_APP_URL: 'https://app.test' }) }))
vi.mock('@/lib/prisma', () => ({ getPrisma: () => ({}) }))
const disconnectNotion = vi.fn()
vi.mock('@/lib/data/connections', () => ({ disconnectNotion: (...a: unknown[]) => disconnectNotion(...(a as Parameters<typeof disconnectNotion>)) }))

import type { NextRequest } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { POST } from './route'

const mockedAuth = vi.mocked(auth)

function reqWithOrigin(origin: string | null): NextRequest {
  const headers = new Headers()
  if (origin !== null) headers.set('origin', origin)
  return new Request('https://app.test/api/notion/disconnect', { method: 'POST', headers }) as unknown as NextRequest
}

describe('POST /api/notion/disconnect', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a cross-origin request with 403 and does not touch data', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    const res = await POST(reqWithOrigin('https://evil.test'))
    expect(res.status).toBe(403)
    expect(disconnectNotion).not.toHaveBeenCalled()
  })

  it('rejects a request with no Origin header with 403', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    const res = await POST(reqWithOrigin(null))
    expect(res.status).toBe(403)
    expect(disconnectNotion).not.toHaveBeenCalled()
  })

  it('returns 401 when unauthenticated even with a valid origin', async () => {
    mockedAuth.mockResolvedValue({ userId: null } as never)
    const res = await POST(reqWithOrigin('https://app.test'))
    expect(res.status).toBe(401)
    expect(disconnectNotion).not.toHaveBeenCalled()
  })

  it('disconnects for an authed same-origin request', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    disconnectNotion.mockResolvedValue(true)
    const res = await POST(reqWithOrigin('https://app.test'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ disconnected: true })
    expect(disconnectNotion).toHaveBeenCalledWith(expect.anything(), 'user_123')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/api/notion/disconnect/route.test.ts`
Expected: FAIL — `POST()` ignores the request/origin; 403 cases return 200/401.

- [ ] **Step 3: Implement the guard**

```ts
// app/api/notion/disconnect/route.ts
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getEnv } from '@/lib/env'
import { getPrisma } from '@/lib/prisma'
import { disconnectNotion } from '@/lib/data/connections'
import { log } from '@/lib/log'

// Route handlers are not covered by Next's built-in Server Action CSRF check, so we
// enforce same-origin ourselves: a same-origin fetch POST always sends `Origin`.
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
  const env = getEnv()
  if (!isSameOrigin(req, env.NEXT_PUBLIC_APP_URL)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const disconnected = await disconnectNotion(getPrisma(), userId)
  log.info('notion_disconnected', { userId, disconnected })
  return NextResponse.json({ disconnected })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/api/notion/disconnect/route.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/notion/disconnect/route.ts app/api/notion/disconnect/route.test.ts
git commit -m "feat(notion): enforce same-origin on disconnect and log revoke"
```

---

### Task 4: `?notion=` status banner on `/app`

**Files:**
- Create: `app/app/notion-status.ts`
- Test: `app/app/notion-status.test.ts`
- Create: `app/app/notion-status-banner.tsx`
- Modify: `app/app/page.tsx`

- [ ] **Step 1: Write the failing test for the pure mapping**

```ts
// app/app/notion-status.test.ts
import { describe, it, expect } from 'vitest'
import { notionStatusBanner } from './notion-status'

describe('notionStatusBanner', () => {
  it('returns a success banner for connected', () => {
    expect(notionStatusBanner('connected')).toEqual({ tone: 'success', message: 'Notion connected.' })
  })
  it('returns an error-tone banner for denied, invalid, and error', () => {
    expect(notionStatusBanner('denied')?.tone).toBe('error')
    expect(notionStatusBanner('invalid')?.tone).toBe('error')
    expect(notionStatusBanner('error')?.tone).toBe('error')
  })
  it('returns distinct messages per failure status', () => {
    const msgs = new Set([
      notionStatusBanner('denied')?.message,
      notionStatusBanner('invalid')?.message,
      notionStatusBanner('error')?.message,
    ])
    expect(msgs.size).toBe(3)
  })
  it('returns null for unknown or absent status', () => {
    expect(notionStatusBanner(undefined)).toBeNull()
    expect(notionStatusBanner('bogus')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/app/notion-status.test.ts`
Expected: FAIL — cannot find module `./notion-status`.

- [ ] **Step 3: Implement the pure mapping**

```ts
// app/app/notion-status.ts
export type BannerTone = 'success' | 'error'
export interface Banner {
  tone: BannerTone
  message: string
}

const BANNERS: Record<string, Banner> = {
  connected: { tone: 'success', message: 'Notion connected.' },
  denied: { tone: 'error', message: 'Notion connection was denied.' },
  invalid: { tone: 'error', message: 'That connection link was invalid or expired. Please try again.' },
  error: { tone: 'error', message: 'Something went wrong connecting Notion. Please try again.' },
}

export function notionStatusBanner(status: string | undefined): Banner | null {
  if (!status) return null
  return BANNERS[status] ?? null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/app/notion-status.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Create the presentational component**

```tsx
// app/app/notion-status-banner.tsx
import { notionStatusBanner } from './notion-status'

export function NotionStatusBanner({ status }: { status: string | undefined }) {
  const banner = notionStatusBanner(status)
  if (!banner) return null
  const tone =
    banner.tone === 'success'
      ? 'border-green-200 bg-green-50 text-green-800'
      : 'border-red-200 bg-red-50 text-red-800'
  return (
    <p role="status" className={`rounded border px-3 py-2 text-sm ${tone}`}>
      {banner.message}
    </p>
  )
}
```

- [ ] **Step 6: Wire it into the page**

Modify `app/app/page.tsx` — accept async `searchParams` and render the banner:

```tsx
import { auth } from '@clerk/nextjs/server'
import { getPrisma } from '@/lib/prisma'
import { getWorkspaceForUser } from '@/lib/data/connections'
import { DisconnectButton } from './disconnect-button'
import { NotionStatusBanner } from './notion-status-banner'

export default async function AppHome({
  searchParams,
}: {
  searchParams: Promise<{ notion?: string }>
}) {
  const { notion } = await searchParams
  const { userId } = await auth()
  const workspace = userId ? await getWorkspaceForUser(getPrisma(), userId) : null
  const connection = workspace?.notionConnection ?? null

  return (
    <main className="space-y-4 p-8">
      <h1 className="text-xl font-semibold">NotionIQ</h1>
      <NotionStatusBanner status={notion} />
      {connection ? (
        <div className="space-y-2">
          <p className="text-sm text-gray-600">
            Connected to{' '}
            <strong>{connection.notionWorkspaceName ?? 'your Notion workspace'}</strong>.
          </p>
          <DisconnectButton />
        </div>
      ) : (
        <a
          href="/api/notion/connect"
          className="inline-block rounded bg-black px-4 py-2 text-sm text-white"
        >
          Connect Notion
        </a>
      )}
    </main>
  )
}
```

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run app/app/notion-status.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/app/notion-status.ts app/app/notion-status.test.ts app/app/notion-status-banner.tsx app/app/page.tsx
git commit -m "feat(app): surface notion connection status banner"
```

---

### Task 5: Bump CI runtime

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Update action versions and Node**

Change `actions/checkout@v4` → `actions/checkout@v5`, `actions/setup-node@v4` → `actions/setup-node@v5`, and `node-version: 20` → `node-version: 22`.

- [ ] **Step 2: Verify the full gate locally**

Run: `npm run typecheck && npm run lint && npm run test && npm run build`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(github): bump actions to v5 and node to 22 lts"
```

---

## Self-Review

- **Spec coverage:** Item 1 (A09 logging) → Tasks 1+2 (+ revoke event in Task 3). Item 2 (status banner) → Task 4. Item 3 (A07 same-origin) → Task 3. Item 4 (CI bump) → Task 5. All four covered.
- **Type consistency:** `log.{info,warn,error}(event, fields?)` used identically across Tasks 1–3. `notionStatusBanner(status)` and `Banner`/`BannerTone` consistent across Task 4. Disconnect `POST(req: NextRequest)` signature matches the new test calls.
- **Secrets:** logger only ever receives `userId`, `notionWorkspaceId`, `disconnected` — never tokens/codes/secrets. The Task 2 test asserts no `secret` string in logged fields.
- **Test env:** all new tests run under `environment: node` (pure functions + route handlers); no jsdom/RTL needed.
