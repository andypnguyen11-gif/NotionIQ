# Notion Connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authenticated user connect their Notion workspace via OAuth, store the access token encrypted at rest (AES-256-GCM), and disconnect it.

**Architecture:** A Clerk-authenticated user clicks "Connect Notion" → our `connect` route redirects to Notion's OAuth authorize URL carrying an HMAC-signed `state` (binds the flow to the user, 10-min expiry). Notion redirects back to our `callback` route, which verifies `state`, exchanges the `code` for an access token, encrypts it, and upserts a `Workspace` + `NotionConnection`. Disconnect deletes the connection. Security-critical helpers (token cipher, OAuth state signer, Notion OAuth client, tenant-scoped data access) are **pure** — secrets/clients are passed in as arguments — so they are unit-tested in isolation; route handlers are the thin glue that reads `getEnv()`/`getPrisma()` and wires them together.

**Tech Stack:** Next.js 16 App Router route handlers, Clerk (`@clerk/nextjs/server` `auth()`), Prisma 7 (`@prisma/client`), Node `crypto` (AES-256-GCM + HMAC-SHA256), zod, Vitest. No Notion SDK in M1 — token exchange uses `fetch` (the SDK arrives in M2 for scanning).

**Conventions (from AGENTS.md):**
- TDD: failing test → run (see fail) → minimal impl → run (see pass) → commit.
- Tenant scoping mandatory: no data-access call without `userId`/`workspaceId`.
- Secrets read only via `getEnv()`; pure helpers receive them as arguments.
- Conventional commits with a scope, e.g. `feat(notion): …`. No PR/task numbers. No AI attribution. Author is the repo owner.
- Read `node_modules/next/dist/docs/` before writing route-handler code — this is Next.js 16.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `prisma/schema.prisma` (modify) | Add `Workspace` + `NotionConnection` models. |
| `prisma/schema.test.ts` (create) | Assert the generated Prisma client exposes the new model delegates (offline, no DB). |
| `lib/env.ts` (modify) | Add Notion OAuth creds, token-encryption key, OAuth state secret to the zod schema. |
| `.env.example` (modify) | Placeholder values for the new env vars. |
| `lib/crypto/token-cipher.ts` (create) | `encryptToken(plaintext, keyB64)` / `decryptToken(encoded, keyB64)` — AES-256-GCM. |
| `lib/crypto/token-cipher.test.ts` (create) | Round-trip, IV-uniqueness, tamper-detection, bad-key tests. |
| `lib/notion/oauth-state.ts` (create) | `signState(payload, secret)` / `verifyState(token, secret, nowMs)` — HMAC-signed CSRF state. |
| `lib/notion/oauth-state.test.ts` (create) | Valid round-trip, tamper, expiry, malformed tests. |
| `lib/notion/oauth.ts` (create) | `buildAuthorizeUrl(...)` + `exchangeCodeForToken(...)` (injectable `fetch`). |
| `lib/notion/oauth.test.ts` (create) | Authorize-URL shape; token-exchange success/non-ok/invalid-shape tests (mock fetch). |
| `lib/data/connections.ts` (create) | Tenant-scoped `saveNotionConnection` / `getWorkspaceForUser` / `disconnectNotion` (injected `PrismaClient`). |
| `lib/data/connections.test.ts` (create) | Upsert/read/delete behavior against a fake Prisma client. |
| `app/api/notion/connect/route.ts` (create) | `GET`: authed → redirect to Notion authorize URL with signed state; else → `/sign-in`. |
| `app/api/notion/connect/route.test.ts` (create) | Authed redirect + unauth redirect (mock `auth`/`getEnv`). |
| `app/api/notion/callback/route.ts` (create) | `GET`: verify state → exchange → encrypt → persist → redirect to `/app`. |
| `app/api/notion/callback/route.test.ts` (create) | Rejects bad/expired state; missing code path (mock helpers). |
| `app/api/notion/disconnect/route.ts` (create) | `POST`: authed → delete connection → JSON. |
| `app/app/page.tsx` (modify) | Server component: show connection status + Connect / Disconnect. |
| `app/app/disconnect-button.tsx` (create) | Client component: POST disconnect, refresh. |

**Component testing note:** React components (`page.tsx`, `disconnect-button.tsx`) are intentionally thin glue with no business logic, and the stack has no React Testing Library (YAGNI — don't add it for M1). All testable logic lives in `lib/` helpers, which are covered. The components are verified by `npm run typecheck` and `npm run build`, matching the M0 precedent (no test for `layout.tsx`).

---

### Task 1: Prisma models — `Workspace` + `NotionConnection`

Resolves the tracked prereq "Prisma v7 generator + datasource URL": the generator is already `prisma-client-js` and `DATABASE_URL` is wired via `prisma.config.ts`; this task proves it by generating a client with real models and (when a DB is available) creating the first migration.

**Files:**
- Modify: `prisma/schema.prisma`
- Test: `prisma/schema.test.ts`

- [ ] **Step 1: Write the failing test**

`prisma/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { PrismaClient } from '@prisma/client'

// Constructing PrismaClient does NOT connect — it only connects on first query —
// so this runs offline and just asserts the generated client has our model delegates.
describe('prisma schema', () => {
  it('exposes the workspace and notionConnection model delegates', () => {
    const client = new PrismaClient()
    expect(client).toHaveProperty('workspace')
    expect(client).toHaveProperty('notionConnection')
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test -- --run prisma/schema.test.ts`
Expected: FAIL — the generated client has no `workspace`/`notionConnection` delegate (or `@prisma/client` not generated yet).

- [ ] **Step 3: Add the models**

Replace the contents of `prisma/schema.prisma` with:

```prisma
// This is your Prisma schema file,
// learn more about it in the docs: https://pris.ly/d/prisma-schema

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}

model Workspace {
  id              String   @id @default(cuid())
  userId          String   @unique // Clerk user id — the tenant owner (ADR-3 scoping key)
  name            String
  snapshotVersion Int      @default(0) // bumped each scan (spec §5); 0 until first scan
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  notionConnection NotionConnection?
}

model NotionConnection {
  id                  String    @id @default(cuid())
  workspaceId         String    @unique
  workspace           Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  notionWorkspaceId   String // Notion's workspace_id
  notionWorkspaceName String?
  botId               String
  encryptedToken      String // AES-256-GCM ciphertext of the Notion access token (never plaintext)
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
}
```

- [ ] **Step 4: Regenerate the client and run the test**

Run: `npx prisma generate && npm run test -- --run prisma/schema.test.ts`
Expected: `prisma generate` succeeds; test PASSES.

- [ ] **Step 5: Create the first migration (requires a dev Postgres)**

Ensure `DATABASE_URL` in `.env` points at a real dev Postgres (e.g. a free Neon database), then run:

Run: `npx prisma migrate dev --name notion_connect_init`
Expected: creates `prisma/migrations/<timestamp>_notion_connect_init/migration.sql` and applies it.

> If no database is reachable in this environment, skip applying but still generate the SQL so the migration is committed:
> `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > /tmp/migration.sql` and hand-place it under `prisma/migrations/0001_notion_connect_init/migration.sql`, then note in the commit body that it is unapplied. The `migrate dev` form is strongly preferred when a DB exists.

- [ ] **Step 6: Verify the full gate, then commit**

Run: `npm run typecheck && npm run lint && npm run test -- --run && npm run build`
Expected: all pass.

```bash
git add prisma/schema.prisma prisma/schema.test.ts prisma/migrations
git commit -m "feat(db): add workspace and notion-connection models"
```

---

### Task 2: Environment variables for Notion OAuth + token encryption

**Files:**
- Modify: `lib/env.ts`
- Modify: `.env.example`
- Test: `lib/env.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `lib/env.test.ts` (inside the existing `describe`, alongside the current cases):

```ts
it('requires the notion oauth and crypto secrets', () => {
  expect(() =>
    parseEnv({
      DATABASE_URL: 'postgres://x',
      NEXT_PUBLIC_APP_URL: 'https://app.test',
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x',
      CLERK_SECRET_KEY: 'sk_test_x',
      // notion + crypto secrets intentionally omitted
    }),
  ).toThrow(/NOTION_OAUTH_CLIENT_ID|TOKEN_ENCRYPTION_KEY|OAUTH_STATE_SECRET/)
})

it('accepts a fully-populated env including notion + crypto secrets', () => {
  const env = parseEnv({
    DATABASE_URL: 'postgres://x',
    NEXT_PUBLIC_APP_URL: 'https://app.test',
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x',
    CLERK_SECRET_KEY: 'sk_test_x',
    NOTION_OAUTH_CLIENT_ID: 'cid',
    NOTION_OAUTH_CLIENT_SECRET: 'csecret',
    NOTION_OAUTH_REDIRECT_URI: 'https://app.test/api/notion/callback',
    TOKEN_ENCRYPTION_KEY: 'Z'.repeat(44), // base64-ish placeholder, length-checked at use site
    OAUTH_STATE_SECRET: 'a-sufficiently-long-state-secret',
  })
  expect(env.NOTION_OAUTH_CLIENT_ID).toBe('cid')
  expect(env.OAUTH_STATE_SECRET).toBe('a-sufficiently-long-state-secret')
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test -- --run lib/env.test.ts`
Expected: FAIL — schema does not yet include the new keys, so the "requires" test does not throw and `.NOTION_OAUTH_CLIENT_ID` is `undefined`.

- [ ] **Step 3: Extend the schema**

In `lib/env.ts`, replace the `envSchema` definition with:

```ts
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1, 'CLERK publishable key is required'),
  CLERK_SECRET_KEY: z.string().min(1, 'CLERK secret key is required'),
  NOTION_OAUTH_CLIENT_ID: z.string().min(1, 'NOTION_OAUTH_CLIENT_ID is required'),
  NOTION_OAUTH_CLIENT_SECRET: z.string().min(1, 'NOTION_OAUTH_CLIENT_SECRET is required'),
  NOTION_OAUTH_REDIRECT_URI: z.string().url(),
  TOKEN_ENCRYPTION_KEY: z.string().min(1, 'TOKEN_ENCRYPTION_KEY is required'),
  OAUTH_STATE_SECRET: z.string().min(16, 'OAUTH_STATE_SECRET must be at least 16 chars'),
})
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test -- --run lib/env.test.ts`
Expected: PASS.

- [ ] **Step 5: Add placeholders to `.env.example`**

Append to `.env.example`:

```bash
# Notion OAuth (create an integration at https://www.notion.so/my-integrations)
NOTION_OAUTH_CLIENT_ID=your-notion-oauth-client-id
NOTION_OAUTH_CLIENT_SECRET=your-notion-oauth-client-secret
NOTION_OAUTH_REDIRECT_URI=http://localhost:3000/api/notion/callback

# AES-256-GCM key for encrypting Notion tokens at rest — 32 random bytes, base64-encoded.
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
TOKEN_ENCRYPTION_KEY=replace-with-base64-32-byte-key

# HMAC secret for signing the OAuth state parameter (>=16 chars, random).
# Generate: node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
OAUTH_STATE_SECRET=replace-with-random-state-secret
```

> Build/CI note: the route handlers call `getEnv()` at request time (they use `auth()`/`headers`, so they are dynamic and not prerendered). `npm run build` therefore does NOT evaluate them, and the existing CI placeholder env is sufficient — no `.github/workflows/ci.yml` change is required for this task.

- [ ] **Step 6: Commit**

```bash
git add lib/env.ts lib/env.test.ts .env.example
git commit -m "feat(env): add notion oauth and token-encryption config"
```

---

### Task 3: AES-256-GCM token cipher

**Files:**
- Create: `lib/crypto/token-cipher.ts`
- Test: `lib/crypto/token-cipher.test.ts`

- [ ] **Step 1: Write the failing test**

`lib/crypto/token-cipher.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { encryptToken, decryptToken } from './token-cipher'

const keyB64 = randomBytes(32).toString('base64')

describe('token-cipher', () => {
  it('round-trips a plaintext token', () => {
    const ciphertext = encryptToken('secret-notion-token', keyB64)
    expect(decryptToken(ciphertext, keyB64)).toBe('secret-notion-token')
  })

  it('produces different ciphertext each call (random IV) and is not the plaintext', () => {
    const a = encryptToken('same', keyB64)
    const b = encryptToken('same', keyB64)
    expect(a).not.toBe(b)
    expect(a).not.toContain('same')
  })

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    const ciphertext = encryptToken('secret', keyB64)
    const buf = Buffer.from(ciphertext, 'base64')
    buf[buf.length - 1] ^= 0x01 // flip a bit in the ciphertext
    expect(() => decryptToken(buf.toString('base64'), keyB64)).toThrow()
  })

  it('rejects decryption with the wrong key', () => {
    const ciphertext = encryptToken('secret', keyB64)
    const otherKey = randomBytes(32).toString('base64')
    expect(() => decryptToken(ciphertext, otherKey)).toThrow()
  })

  it('rejects a key that is not 32 bytes', () => {
    const shortKey = randomBytes(16).toString('base64')
    expect(() => encryptToken('secret', shortKey)).toThrow(/32 bytes/)
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test -- --run lib/crypto/token-cipher.test.ts`
Expected: FAIL — `Cannot find module './token-cipher'`.

- [ ] **Step 3: Implement the cipher**

`lib/crypto/token-cipher.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

function decodeKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64')
  if (key.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes')
  }
  return key
}

/** Encrypts plaintext with AES-256-GCM. Output = base64(iv || authTag || ciphertext). */
export function encryptToken(plaintext: string, keyB64: string): string {
  const key = decodeKey(keyB64)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

/** Reverses encryptToken; throws if the key is wrong or the data was tampered with. */
export function decryptToken(encoded: string, keyB64: string): string {
  const key = decodeKey(keyB64)
  const buf = Buffer.from(encoded, 'base64')
  const iv = buf.subarray(0, IV_BYTES)
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test -- --run lib/crypto/token-cipher.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/crypto/token-cipher.ts lib/crypto/token-cipher.test.ts
git commit -m "feat(crypto): add aes-256-gcm token cipher"
```

---

### Task 4: HMAC-signed OAuth state

**Files:**
- Create: `lib/notion/oauth-state.ts`
- Test: `lib/notion/oauth-state.test.ts`

- [ ] **Step 1: Write the failing test**

`lib/notion/oauth-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { signState, verifyState } from './oauth-state'

const secret = 'a-sufficiently-long-state-secret'
const now = 1_000_000

describe('oauth-state', () => {
  it('round-trips a signed state', () => {
    const token = signState({ u: 'user_123', n: 'nonce', e: now + 1000 }, secret)
    const payload = verifyState(token, secret, now)
    expect(payload).toEqual({ u: 'user_123', n: 'nonce', e: now + 1000 })
  })

  it('rejects a state signed with a different secret', () => {
    const token = signState({ u: 'user_123', n: 'nonce', e: now + 1000 }, secret)
    expect(verifyState(token, 'another-secret-entirely', now)).toBeNull()
  })

  it('rejects a tampered body', () => {
    const token = signState({ u: 'user_123', n: 'nonce', e: now + 1000 }, secret)
    const [body, sig] = token.split('.')
    const forged = Buffer.from('{"u":"attacker","n":"n","e":9999999}').toString('base64url')
    expect(verifyState(`${forged}.${sig}`, secret, now)).toBeNull()
    expect(body).toBeTruthy()
  })

  it('rejects an expired state', () => {
    const token = signState({ u: 'user_123', n: 'nonce', e: now - 1 }, secret)
    expect(verifyState(token, secret, now)).toBeNull()
  })

  it('rejects a malformed token', () => {
    expect(verifyState('not-a-valid-token', secret, now)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test -- --run lib/notion/oauth-state.test.ts`
Expected: FAIL — `Cannot find module './oauth-state'`.

- [ ] **Step 3: Implement the signer**

`lib/notion/oauth-state.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

/** u = Clerk userId, n = random nonce, e = absolute expiry in epoch ms. */
export type StatePayload = { u: string; n: string; e: number }

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function sign(body: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(body).digest())
}

/** Returns `base64url(json).base64url(hmac)`. */
export function signState(payload: StatePayload, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)))
  return `${body}.${sign(body, secret)}`
}

/** Verifies signature + expiry; returns the payload or null. */
export function verifyState(token: string, secret: string, nowMs: number): StatePayload | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, sig] = parts

  const expected = sign(body, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  let payload: StatePayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload
  } catch {
    return null
  }
  if (typeof payload.u !== 'string' || typeof payload.e !== 'number' || payload.e < nowMs) {
    return null
  }
  return payload
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test -- --run lib/notion/oauth-state.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/notion/oauth-state.ts lib/notion/oauth-state.test.ts
git commit -m "feat(notion): add hmac-signed oauth state"
```

---

### Task 5: Notion OAuth client

**Files:**
- Create: `lib/notion/oauth.ts`
- Test: `lib/notion/oauth.test.ts`

- [ ] **Step 1: Write the failing test**

`lib/notion/oauth.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { buildAuthorizeUrl, exchangeCodeForToken } from './oauth'

describe('buildAuthorizeUrl', () => {
  it('builds a Notion authorize URL with the required params', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'cid',
        redirectUri: 'https://app.test/api/notion/callback',
        state: 'signed-state',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://api.notion.com/v1/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('owner')).toBe('user')
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/api/notion/callback')
    expect(url.searchParams.get('state')).toBe('signed-state')
  })
})

describe('exchangeCodeForToken', () => {
  const base = {
    code: 'abc',
    clientId: 'cid',
    clientSecret: 'csecret',
    redirectUri: 'https://app.test/api/notion/callback',
  }

  it('exchanges a code and maps the response', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: 'tok',
          bot_id: 'bot',
          workspace_id: 'ws',
          workspace_name: 'Acme',
        }),
        { status: 200 },
      ),
    )
    const result = await exchangeCodeForToken({ ...base, fetchImpl })
    expect(result).toEqual({
      accessToken: 'tok',
      botId: 'bot',
      workspaceId: 'ws',
      workspaceName: 'Acme',
    })
    // sends Basic auth + JSON grant
    const [, init] = fetchImpl.mock.calls[0]
    expect((init?.headers as Record<string, string>).Authorization).toMatch(/^Basic /)
    expect(JSON.parse(init?.body as string)).toMatchObject({ grant_type: 'authorization_code', code: 'abc' })
  })

  it('throws on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 400 }))
    await expect(exchangeCodeForToken({ ...base, fetchImpl })).rejects.toThrow(/400/)
  })

  it('throws on a response missing required fields', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }))
    await expect(exchangeCodeForToken({ ...base, fetchImpl })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test -- --run lib/notion/oauth.test.ts`
Expected: FAIL — `Cannot find module './oauth'`.

- [ ] **Step 3: Implement the client**

`lib/notion/oauth.ts`:

```ts
import { z } from 'zod'

const AUTHORIZE_URL = 'https://api.notion.com/v1/oauth/authorize'
const TOKEN_URL = 'https://api.notion.com/v1/oauth/token'
const NOTION_VERSION = '2022-06-28'

export function buildAuthorizeUrl(params: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('owner', 'user')
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('state', params.state)
  return url.toString()
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  bot_id: z.string().min(1),
  workspace_id: z.string().min(1),
  workspace_name: z.string().nullable().optional(),
})

export type NotionTokenResult = {
  accessToken: string
  botId: string
  workspaceId: string
  workspaceName: string | null
}

export async function exchangeCodeForToken(params: {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
  fetchImpl?: typeof fetch
}): Promise<NotionTokenResult> {
  const doFetch = params.fetchImpl ?? fetch
  const basic = Buffer.from(`${params.clientId}:${params.clientSecret}`).toString('base64')

  const res = await doFetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_VERSION,
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
    }),
  })

  if (!res.ok) {
    throw new Error(`Notion token exchange failed: ${res.status}`)
  }

  const parsed = TokenResponse.parse(await res.json())
  return {
    accessToken: parsed.access_token,
    botId: parsed.bot_id,
    workspaceId: parsed.workspace_id,
    workspaceName: parsed.workspace_name ?? null,
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test -- --run lib/notion/oauth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/notion/oauth.ts lib/notion/oauth.test.ts
git commit -m "feat(notion): add oauth authorize-url and token-exchange client"
```

---

### Task 6: Tenant-scoped connection data access

**Files:**
- Create: `lib/data/connections.ts`
- Test: `lib/data/connections.test.ts`

- [ ] **Step 1: Write the failing test**

`lib/data/connections.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { saveNotionConnection, getWorkspaceForUser, disconnectNotion } from './connections'

function fakePrisma(overrides: Record<string, unknown> = {}) {
  return {
    workspace: {
      upsert: vi.fn(async () => ({ id: 'ws_1' })),
      findUnique: vi.fn(async () => null),
    },
    notionConnection: {
      upsert: vi.fn(async () => ({ id: 'conn_1' })),
      delete: vi.fn(async () => ({ id: 'conn_1' })),
    },
    ...overrides,
  } as unknown as PrismaClient
}

const input = {
  userId: 'user_123',
  notionWorkspaceId: 'ws_notion',
  notionWorkspaceName: 'Acme',
  botId: 'bot',
  encryptedToken: 'cipher',
}

describe('saveNotionConnection', () => {
  it('upserts the workspace by userId then the connection by workspaceId', async () => {
    const prisma = fakePrisma()
    const result = await saveNotionConnection(prisma, input)
    expect(result).toEqual({ workspaceId: 'ws_1' })
    expect(prisma.workspace.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user_123' } }),
    )
    expect(prisma.notionConnection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'ws_1' } }),
    )
  })
})

describe('getWorkspaceForUser', () => {
  it('reads the workspace scoped by userId with its connection', async () => {
    const prisma = fakePrisma({
      workspace: {
        findUnique: vi.fn(async () => ({ id: 'ws_1', notionConnection: { id: 'conn_1' } })),
        upsert: vi.fn(),
      },
    })
    const ws = await getWorkspaceForUser(prisma, 'user_123')
    expect(ws).toMatchObject({ id: 'ws_1' })
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { userId: 'user_123' },
      include: { notionConnection: true },
    })
  })
})

describe('disconnectNotion', () => {
  it('returns false when there is no connection', async () => {
    const prisma = fakePrisma({
      workspace: { findUnique: vi.fn(async () => ({ id: 'ws_1', notionConnection: null })), upsert: vi.fn() },
    })
    expect(await disconnectNotion(prisma, 'user_123')).toBe(false)
  })

  it('deletes the connection and returns true when present', async () => {
    const del = vi.fn(async () => ({ id: 'conn_1' }))
    const prisma = fakePrisma({
      workspace: {
        findUnique: vi.fn(async () => ({ id: 'ws_1', notionConnection: { id: 'conn_1' } })),
        upsert: vi.fn(),
      },
      notionConnection: { upsert: vi.fn(), delete: del },
    })
    expect(await disconnectNotion(prisma, 'user_123')).toBe(true)
    expect(del).toHaveBeenCalledWith({ where: { workspaceId: 'ws_1' } })
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test -- --run lib/data/connections.test.ts`
Expected: FAIL — `Cannot find module './connections'`.

- [ ] **Step 3: Implement the data-access module**

`lib/data/connections.ts`:

```ts
import type { PrismaClient } from '@prisma/client'

export type SaveConnectionInput = {
  userId: string
  notionWorkspaceId: string
  notionWorkspaceName: string | null
  botId: string
  encryptedToken: string
}

/**
 * Upserts the user's single workspace and its Notion connection. Tenant-scoped by
 * userId (ADR-3). Reconnecting replaces the stored token. Returns the workspace id.
 */
export async function saveNotionConnection(
  prisma: PrismaClient,
  input: SaveConnectionInput,
): Promise<{ workspaceId: string }> {
  const workspace = await prisma.workspace.upsert({
    where: { userId: input.userId },
    create: { userId: input.userId, name: input.notionWorkspaceName ?? 'My Workspace' },
    update: {},
  })

  const connectionFields = {
    notionWorkspaceId: input.notionWorkspaceId,
    notionWorkspaceName: input.notionWorkspaceName,
    botId: input.botId,
    encryptedToken: input.encryptedToken,
  }

  await prisma.notionConnection.upsert({
    where: { workspaceId: workspace.id },
    create: { workspaceId: workspace.id, ...connectionFields },
    update: connectionFields,
  })

  return { workspaceId: workspace.id }
}

export async function getWorkspaceForUser(prisma: PrismaClient, userId: string) {
  return prisma.workspace.findUnique({
    where: { userId },
    include: { notionConnection: true },
  })
}

export async function disconnectNotion(prisma: PrismaClient, userId: string): Promise<boolean> {
  const workspace = await prisma.workspace.findUnique({
    where: { userId },
    include: { notionConnection: true },
  })
  if (!workspace?.notionConnection) return false
  await prisma.notionConnection.delete({ where: { workspaceId: workspace.id } })
  return true
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test -- --run lib/data/connections.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/data/connections.ts lib/data/connections.test.ts
git commit -m "feat(data): add tenant-scoped notion connection access"
```

---

### Task 7: Connect route

**Files:**
- Create: `app/api/notion/connect/route.ts`
- Test: `app/api/notion/connect/route.test.ts`

- [ ] **Step 1: Write the failing test**

`app/api/notion/connect/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }))
vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    NEXT_PUBLIC_APP_URL: 'https://app.test',
    NOTION_OAUTH_CLIENT_ID: 'cid',
    NOTION_OAUTH_REDIRECT_URI: 'https://app.test/api/notion/callback',
    OAUTH_STATE_SECRET: 'a-sufficiently-long-state-secret',
  }),
}))

import { auth } from '@clerk/nextjs/server'
import { GET } from './route'

const mockedAuth = vi.mocked(auth)

describe('GET /api/notion/connect', () => {
  beforeEach(() => vi.clearAllMocks())

  it('redirects an authed user to the Notion authorize URL', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    const res = await GET()
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('https://api.notion.com/v1/oauth/authorize')
    expect(location).toContain('client_id=cid')
    expect(location).toContain('state=')
  })

  it('redirects an unauthenticated user to sign-in', async () => {
    mockedAuth.mockResolvedValue({ userId: null } as never)
    const res = await GET()
    expect(res.headers.get('location')).toBe('https://app.test/sign-in')
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test -- --run app/api/notion/connect/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Implement the route**

`app/api/notion/connect/route.ts`:

```ts
import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getEnv } from '@/lib/env'
import { buildAuthorizeUrl } from '@/lib/notion/oauth'
import { signState } from '@/lib/notion/oauth-state'

const STATE_TTL_MS = 10 * 60 * 1000

export async function GET() {
  const env = getEnv()
  const { userId } = await auth()

  if (!userId) {
    return NextResponse.redirect(new URL('/sign-in', env.NEXT_PUBLIC_APP_URL))
  }

  const state = signState(
    { u: userId, n: randomBytes(16).toString('hex'), e: Date.now() + STATE_TTL_MS },
    env.OAUTH_STATE_SECRET,
  )

  const authorizeUrl = buildAuthorizeUrl({
    clientId: env.NOTION_OAUTH_CLIENT_ID,
    redirectUri: env.NOTION_OAUTH_REDIRECT_URI,
    state,
  })

  return NextResponse.redirect(authorizeUrl)
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test -- --run app/api/notion/connect/route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/notion/connect/route.ts app/api/notion/connect/route.test.ts
git commit -m "feat(notion): add oauth connect route"
```

---

### Task 8: Callback route

**Files:**
- Create: `app/api/notion/callback/route.ts`
- Test: `app/api/notion/callback/route.test.ts`

- [ ] **Step 1: Write the failing test**

`app/api/notion/callback/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }))
vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    NEXT_PUBLIC_APP_URL: 'https://app.test',
    NOTION_OAUTH_CLIENT_ID: 'cid',
    NOTION_OAUTH_CLIENT_SECRET: 'csecret',
    NOTION_OAUTH_REDIRECT_URI: 'https://app.test/api/notion/callback',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    OAUTH_STATE_SECRET: 'a-sufficiently-long-state-secret',
  }),
}))
vi.mock('@/lib/prisma', () => ({ getPrisma: () => ({}) }))
const saveNotionConnection = vi.fn(async () => ({ workspaceId: 'ws_1' }))
vi.mock('@/lib/data/connections', () => ({ saveNotionConnection: (...a: unknown[]) => saveNotionConnection(...a) }))
const exchangeCodeForToken = vi.fn()
vi.mock('@/lib/notion/oauth', () => ({ exchangeCodeForToken: (...a: unknown[]) => exchangeCodeForToken(...a) }))

import { auth } from '@clerk/nextjs/server'
import { signState } from '@/lib/notion/oauth-state'
import { GET } from './route'

const mockedAuth = vi.mocked(auth)
const SECRET = 'a-sufficiently-long-state-secret'

function reqWith(params: Record<string, string>): NextRequest {
  const url = new URL('https://app.test/api/notion/callback')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url)
}

describe('GET /api/notion/callback', () => {
  beforeEach(() => vi.clearAllMocks())

  it('redirects to /app?notion=invalid when code or state is missing', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    const res = await GET(reqWith({ code: 'abc' })) // no state
    expect(res.headers.get('location')).toBe('https://app.test/app?notion=invalid')
    expect(exchangeCodeForToken).not.toHaveBeenCalled()
  })

  it('rejects a state belonging to a different user', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    const state = signState({ u: 'someone_else', n: 'n', e: Date.now() + 60_000 }, SECRET)
    const res = await GET(reqWith({ code: 'abc', state }))
    expect(res.headers.get('location')).toBe('https://app.test/app?notion=invalid')
    expect(exchangeCodeForToken).not.toHaveBeenCalled()
  })

  it('exchanges, persists, and redirects on a valid callback', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    exchangeCodeForToken.mockResolvedValue({
      accessToken: 'tok',
      botId: 'bot',
      workspaceId: 'ws_notion',
      workspaceName: 'Acme',
    })
    const state = signState({ u: 'user_123', n: 'n', e: Date.now() + 60_000 }, SECRET)
    const res = await GET(reqWith({ code: 'abc', state }))
    expect(res.headers.get('location')).toBe('https://app.test/app?notion=connected')
    expect(saveNotionConnection).toHaveBeenCalledOnce()
    const [, savedInput] = saveNotionConnection.mock.calls[0] as [unknown, { encryptedToken: string; userId: string }]
    expect(savedInput.userId).toBe('user_123')
    expect(savedInput.encryptedToken).not.toContain('tok') // stored encrypted, never plaintext
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test -- --run app/api/notion/callback/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Implement the route**

`app/api/notion/callback/route.ts`:

```ts
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getEnv } from '@/lib/env'
import { getPrisma } from '@/lib/prisma'
import { exchangeCodeForToken } from '@/lib/notion/oauth'
import { verifyState } from '@/lib/notion/oauth-state'
import { encryptToken } from '@/lib/crypto/token-cipher'
import { saveNotionConnection } from '@/lib/data/connections'

function redirectToApp(appUrl: string, status: string): NextResponse {
  return NextResponse.redirect(new URL(`/app?notion=${status}`, appUrl))
}

export async function GET(req: NextRequest) {
  const env = getEnv()
  const appUrl = env.NEXT_PUBLIC_APP_URL
  const params = req.nextUrl.searchParams

  if (params.get('error')) {
    return redirectToApp(appUrl, 'denied')
  }

  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state) {
    return redirectToApp(appUrl, 'invalid')
  }

  const { userId } = await auth()
  if (!userId) {
    return NextResponse.redirect(new URL('/sign-in', appUrl))
  }

  const payload = verifyState(state, env.OAUTH_STATE_SECRET, Date.now())
  if (!payload || payload.u !== userId) {
    return redirectToApp(appUrl, 'invalid')
  }

  try {
    const token = await exchangeCodeForToken({
      code,
      clientId: env.NOTION_OAUTH_CLIENT_ID,
      clientSecret: env.NOTION_OAUTH_CLIENT_SECRET,
      redirectUri: env.NOTION_OAUTH_REDIRECT_URI,
    })

    const encryptedToken = encryptToken(token.accessToken, env.TOKEN_ENCRYPTION_KEY)

    await saveNotionConnection(getPrisma(), {
      userId,
      notionWorkspaceId: token.workspaceId,
      notionWorkspaceName: token.workspaceName,
      botId: token.botId,
      encryptedToken,
    })

    return redirectToApp(appUrl, 'connected')
  } catch {
    return redirectToApp(appUrl, 'error')
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test -- --run app/api/notion/callback/route.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/notion/callback/route.ts app/api/notion/callback/route.test.ts
git commit -m "feat(notion): add oauth callback route with encrypted token storage"
```

---

### Task 9: Disconnect route + connection UI

**Files:**
- Create: `app/api/notion/disconnect/route.ts`
- Test: `app/api/notion/disconnect/route.test.ts`
- Create: `app/app/disconnect-button.tsx`
- Modify: `app/app/page.tsx`

- [ ] **Step 1: Write the failing test**

`app/api/notion/disconnect/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ getPrisma: () => ({}) }))
const disconnectNotion = vi.fn()
vi.mock('@/lib/data/connections', () => ({ disconnectNotion: (...a: unknown[]) => disconnectNotion(...a) }))

import { auth } from '@clerk/nextjs/server'
import { POST } from './route'

const mockedAuth = vi.mocked(auth)

describe('POST /api/notion/disconnect', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedAuth.mockResolvedValue({ userId: null } as never)
    const res = await POST()
    expect(res.status).toBe(401)
    expect(disconnectNotion).not.toHaveBeenCalled()
  })

  it('disconnects and returns the result for an authed user', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    disconnectNotion.mockResolvedValue(true)
    const res = await POST()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ disconnected: true })
    expect(disconnectNotion).toHaveBeenCalledWith(expect.anything(), 'user_123')
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test -- --run app/api/notion/disconnect/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Implement the disconnect route**

`app/api/notion/disconnect/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getPrisma } from '@/lib/prisma'
import { disconnectNotion } from '@/lib/data/connections'

export async function POST() {
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const disconnected = await disconnectNotion(getPrisma(), userId)
  return NextResponse.json({ disconnected })
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test -- --run app/api/notion/disconnect/route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the client disconnect button**

`app/app/disconnect-button.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function DisconnectButton() {
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function onClick() {
    setBusy(true)
    try {
      await fetch('/api/notion/disconnect', { method: 'POST' })
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="rounded border px-3 py-1.5 text-sm disabled:opacity-50"
    >
      {busy ? 'Disconnecting…' : 'Disconnect Notion'}
    </button>
  )
}
```

- [ ] **Step 6: Wire the connection status into the app page**

Replace the contents of `app/app/page.tsx` with:

```tsx
import { auth } from '@clerk/nextjs/server'
import { getPrisma } from '@/lib/prisma'
import { getWorkspaceForUser } from '@/lib/data/connections'
import { DisconnectButton } from './disconnect-button'

export default async function AppHome() {
  const { userId } = await auth()
  const workspace = userId ? await getWorkspaceForUser(getPrisma(), userId) : null
  const connection = workspace?.notionConnection ?? null

  return (
    <main className="space-y-4 p-8">
      <h1 className="text-xl font-semibold">NotionIQ</h1>
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

- [ ] **Step 7: Run the full gate**

Run: `npm run typecheck && npm run lint && npm run test -- --run && npm run build`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add app/api/notion/disconnect/route.ts app/api/notion/disconnect/route.test.ts app/app/disconnect-button.tsx app/app/page.tsx
git commit -m "feat(notion): add disconnect route and connection status ui"
```

---

## Final verification

- [ ] Run the full gate one more time on the complete branch:

Run: `npm run typecheck && npm run lint && npm run test -- --run && npm run build`
Expected: all pass.

- [ ] Manual smoke (requires real Notion OAuth app + dev Postgres): set the new `.env` values, `npm run dev`, sign in, visit `/app`, click **Connect Notion**, approve in Notion, land back on `/app?notion=connected` showing the workspace name, then **Disconnect Notion** and confirm the Connect button returns.

## Spec coverage check

- **M1 scope "OAuth connect/disconnect, AES-GCM encrypted token at rest":** connect route (Task 7), callback exchange + persist (Task 8), disconnect (Task 9), AES-256-GCM cipher (Task 3) — token stored only as ciphertext (asserted in Task 8 test).
- **A02 Cryptographic Failures:** token encrypted at rest with AES-256-GCM, key from env; never logged (no token in logs anywhere).
- **A01 / ADR-3 tenant scoping:** every data-access call keyed by `userId`/`workspaceId` (Task 6).
- **A03 Injection / input validation:** zod-validated token-exchange response (Task 5); callback validates presence of `code`/`state` (Task 8).
- **A07 Auth failures / CSRF:** HMAC-signed, user-bound, 10-min-expiry `state` verified on callback (Tasks 4, 7, 8).
- **Prereq #12 (Prisma generator + datasource):** discharged by Task 1 (real models generate + migrate).

## Deferred (not in this milestone, by design)

- `User` table (YAGNI until billing needs user attributes — M6); tenant key is `userId` on `Workspace`.
- Token **refresh/rotation** and audit-log sink — M1 stores and deletes; rotation hygiene lands with the embed-token work (M5) and observability (M6).
- Notion SDK + actual workspace scanning — M2.
