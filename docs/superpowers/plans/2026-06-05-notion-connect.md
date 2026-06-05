# Notion Connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authenticated user connect their Notion workspace via OAuth, store the access token encrypted at rest (AES-256-GCM), and disconnect it.

**Architecture:** A Clerk-authenticated user clicks "Connect Notion" → our `connect` route redirects to Notion's OAuth authorize URL carrying an HMAC-signed, user-bound `state` (10-min expiry) **and sets a first-party `HttpOnly; SameSite=Lax` nonce cookie**. Notion redirects back to our `callback` route, which verifies the state signature/expiry/user, **cross-checks the cookie nonce against the state nonce and clears the cookie (one-time replay defense)**, exchanges the `code` for an access token, encrypts it (AES-256-GCM, AAD-bound to the Notion workspace id), and upserts a `Workspace` (+ owner `WorkspaceMember`) and `NotionConnection`. Disconnect deletes the connection. Security-critical helpers (token cipher, OAuth state signer, Notion OAuth client, tenant-scoped data access) are **pure** — secrets/clients are passed in as arguments — so they are unit-tested in isolation; route handlers are the thin glue that reads `getEnv()`/`getPrisma()` and wires them together.

**Tenancy (ADR-3):** Tenant identity is **`workspaceId`**, never `userId`. The user↔workspace link lives in a `WorkspaceMember` join table, so a Notion workspace can be shared by multiple app users later **with no migration of token data**. For MVP a `@@unique([userId])` constraint on `WorkspaceMember` enforces one workspace per user; relaxing that single constraint is the only change needed when team features land (out of MVP scope per spec §11).

**Tech Stack:** Next.js 16 App Router route handlers, Clerk (`@clerk/nextjs/server` `auth()`), Prisma 7 (`@prisma/client`), Node `crypto` (AES-256-GCM + HMAC-SHA256), zod, Vitest. No Notion SDK in M1 — token exchange uses `fetch` (the SDK arrives in M2 for scanning).

**Conventions (from AGENTS.md):**
- TDD: failing test → run (see fail) → minimal impl → run (see pass) → commit.
- Tenant scoping mandatory: no data-access call without `workspaceId` (resolved from the authenticated `userId` via `WorkspaceMember`).
- Secrets read only via `getEnv()`; pure helpers receive them as arguments.
- Conventional commits with a scope, e.g. `feat(notion): …`. No PR/task numbers. No AI attribution. Author is the repo owner.
- Read `node_modules/next/dist/docs/` before writing route-handler code — this is Next.js 16.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `prisma/schema.prisma` (modify) | Add `Workspace`, `WorkspaceMember`, `NotionConnection` models. |
| `prisma/schema.test.ts` (create) | Assert the generated Prisma client exposes the new model delegates (offline, no DB). |
| `lib/data/db-health.ts` (create) | `pingDatabase(prisma)` — `SELECT 1` connectivity check. |
| `lib/data/db-health.test.ts` (create) | Unit (fake prisma) + optional real-DB integration test, skipped without `DATABASE_URL`. |
| `lib/env.ts` (modify) | Add Notion OAuth creds, token-encryption key, OAuth state secret to the zod schema. |
| `.env.example` (modify) | Placeholder values for the new env vars. |
| `lib/crypto/token-cipher.ts` (create) | `encryptToken(plaintext, keyB64, aad)` / `decryptToken(encoded, keyB64, aad)` — AES-256-GCM, versioned envelope, AAD-bound. |
| `lib/crypto/token-cipher.test.ts` (create) | Round-trip, IV-uniqueness, version, AAD-mismatch, tamper, bad-key tests. |
| `lib/notion/oauth-state.ts` (create) | `signState` / `verifyState` (HMAC) + `OAUTH_NONCE_COOKIE` constant. |
| `lib/notion/oauth-state.test.ts` (create) | Valid round-trip, tamper, expiry, malformed tests. |
| `lib/notion/oauth.ts` (create) | `buildAuthorizeUrl(...)` + `exchangeCodeForToken(...)` (injectable `fetch`, zod-validated response = contract test). |
| `lib/notion/oauth.test.ts` (create) | Authorize-URL shape; token-exchange success/non-ok/invalid-shape tests (mock fetch). |
| `lib/data/connections.ts` (create) | Tenant-scoped `saveNotionConnection` / `getWorkspaceForUser` / `disconnectNotion` via `WorkspaceMember` (injected `PrismaClient`). |
| `lib/data/connections.test.ts` (create) | Create-vs-reuse workspace, read, delete behavior against a fake Prisma client. |
| `app/api/notion/connect/route.ts` (create) | `GET`: authed → signed state + nonce cookie → redirect to Notion authorize URL; else → `/sign-in`. |
| `app/api/notion/connect/route.test.ts` (create) | Authed redirect + cookie/state nonce match; unauth redirect. |
| `app/api/notion/callback/route.ts` (create) | `GET`: verify state + cookie nonce → exchange → encrypt → persist → clear cookie → redirect. |
| `app/api/notion/callback/route.test.ts` (create) | Rejects bad/expired/cross-user state, missing/mismatched cookie; happy path persists encrypted token. |
| `app/api/notion/disconnect/route.ts` (create) | `POST`: authed → delete connection → JSON. |
| `app/api/notion/disconnect/route.test.ts` (create) | 401 unauth; disconnect result for authed user. |
| `app/app/page.tsx` (modify) | Server component: show connection status + Connect / Disconnect. |
| `app/app/disconnect-button.tsx` (create) | Client component: POST disconnect, refresh. |

**Component testing note:** React components (`page.tsx`, `disconnect-button.tsx`) are intentionally thin glue with no business logic, and the stack has no React Testing Library (YAGNI — don't add it for M1). All testable logic lives in `lib/` helpers, which are covered. The components are verified by `npm run typecheck`, `npm run build`, and the documented manual smoke checklist (Final verification), matching the M0 precedent.

---

### Task 1: Prisma models + DB connectivity check

Resolves the tracked prereq "Prisma v7 generator + datasource URL": the generator is already `prisma-client-js` and `DATABASE_URL` is wired via `prisma.config.ts`; this task proves it by generating a client with real models and (when a DB is available) creating the first migration and running a live `SELECT 1`.

**Files:**
- Modify: `prisma/schema.prisma`
- Test: `prisma/schema.test.ts`
- Create: `lib/data/db-health.ts`
- Test: `lib/data/db-health.test.ts`

- [ ] **Step 1: Write the failing schema test**

`prisma/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { PrismaClient } from '@prisma/client'

// Constructing PrismaClient does NOT connect — it only connects on first query —
// so this runs offline and just asserts the generated client has our model delegates.
describe('prisma schema', () => {
  it('exposes the workspace, workspaceMember, and notionConnection delegates', () => {
    const client = new PrismaClient()
    expect(client).toHaveProperty('workspace')
    expect(client).toHaveProperty('workspaceMember')
    expect(client).toHaveProperty('notionConnection')
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test -- --run prisma/schema.test.ts`
Expected: FAIL — the generated client has no `workspace`/`workspaceMember`/`notionConnection` delegate (or `@prisma/client` not generated yet).

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

// Tenant identity is the Workspace (ADR-3). It carries no user column — the
// user link lives in WorkspaceMember so multiple users can share a workspace later.
model Workspace {
  id              String   @id @default(cuid())
  name            String
  snapshotVersion Int      @default(0) // bumped each scan (spec §5); 0 until first scan
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  members          WorkspaceMember[]
  notionConnection NotionConnection?
}

model WorkspaceMember {
  id          String    @id @default(cuid())
  workspaceId String
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  userId      String // Clerk user id
  role        String    @default("owner")
  createdAt   DateTime  @default(now())

  @@unique([workspaceId, userId]) // a user joins a workspace at most once
  @@unique([userId]) // MVP: a user belongs to exactly one workspace — relax this when team features land
}

model NotionConnection {
  id                  String    @id @default(cuid())
  workspaceId         String    @unique
  workspace           Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  notionWorkspaceId   String // Notion's workspace_id; also used as AES-GCM AAD
  notionWorkspaceName String?
  botId               String
  encryptedToken      String // AES-256-GCM ciphertext of the Notion access token (never plaintext)
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
}
```

- [ ] **Step 4: Regenerate the client and run the schema test**

Run: `npx prisma generate && npm run test -- --run prisma/schema.test.ts`
Expected: `prisma generate` succeeds; test PASSES.

- [ ] **Step 5: Write the failing DB-health test**

`lib/data/db-health.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { pingDatabase } from './db-health'

describe('pingDatabase (unit)', () => {
  it('issues a trivial query and returns true', async () => {
    const queryRaw = vi.fn(async () => [{ ok: 1 }])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient
    expect(await pingDatabase(prisma)).toBe(true)
    expect(queryRaw).toHaveBeenCalledOnce()
  })
})

// Lightweight integration check — runs only when a real database is configured,
// so it surfaces connection/startup problems before the live OAuth smoke test.
const itDb = process.env.DATABASE_URL ? it : it.skip
describe('pingDatabase (integration)', () => {
  itDb('connects to the configured Postgres', async () => {
    const { getPrisma } = await import('@/lib/prisma')
    expect(await pingDatabase(getPrisma())).toBe(true)
  })
})
```

- [ ] **Step 6: Run the DB-health test and watch it fail**

Run: `npm run test -- --run lib/data/db-health.test.ts`
Expected: FAIL — `Cannot find module './db-health'`.

- [ ] **Step 7: Implement the DB-health helper**

`lib/data/db-health.ts`:

```ts
import type { PrismaClient } from '@prisma/client'

/** Verifies the database is reachable with a trivial query. Throws on failure. */
export async function pingDatabase(prisma: PrismaClient): Promise<boolean> {
  await prisma.$queryRaw`SELECT 1`
  return true
}
```

- [ ] **Step 8: Run the DB-health test and watch it pass**

Run: `npm run test -- --run lib/data/db-health.test.ts`
Expected: PASS (unit test; integration test skipped unless `DATABASE_URL` is set, in which case it must also pass).

- [ ] **Step 9: Create the first migration (requires a dev Postgres)**

Ensure `DATABASE_URL` in `.env` points at a real dev Postgres (e.g. a free Neon database), then run:

Run: `npx prisma migrate dev --name notion_connect_init`
Expected: creates `prisma/migrations/<timestamp>_notion_connect_init/migration.sql` and applies it.

> If no database is reachable in this environment, skip applying but still generate the SQL so the migration is committed:
> `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > /tmp/migration.sql` and hand-place it under `prisma/migrations/0001_notion_connect_init/migration.sql`, then note in the commit body that it is unapplied. The `migrate dev` form is strongly preferred when a DB exists.

- [ ] **Step 10: Verify the full gate, then commit**

Run: `npm run typecheck && npm run lint && npm run test -- --run && npm run build`
Expected: all pass.

```bash
git add prisma/schema.prisma prisma/schema.test.ts lib/data/db-health.ts lib/data/db-health.test.ts prisma/migrations
git commit -m "feat(db): add workspace, membership, and notion-connection models"
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
    TOKEN_ENCRYPTION_KEY: 'Z'.repeat(44), // base64-ish placeholder; 32-byte length checked at use site
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
# MVP: env-managed; migrate to KMS in hardening (the ciphertext version byte makes rotation non-breaking).
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
TOKEN_ENCRYPTION_KEY=replace-with-base64-32-byte-key

# HMAC secret for signing the OAuth state parameter (>=16 chars, random).
# Generate: node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
OAUTH_STATE_SECRET=replace-with-random-state-secret
```

> Build/CI note: the route handlers call `getEnv()` at request time (they use `auth()`/cookies, so they are dynamic and not prerendered). `npm run build` therefore does NOT evaluate them, and the existing CI placeholder env is sufficient — no `.github/workflows/ci.yml` change is required for this task.

- [ ] **Step 6: Commit**

```bash
git add lib/env.ts lib/env.test.ts .env.example
git commit -m "feat(env): add notion oauth and token-encryption config"
```

---

### Task 3: AES-256-GCM token cipher (versioned, AAD-bound)

Cipher discipline: a **fresh random 96-bit IV per encryption** (GCM nonce-reuse would be catastrophic), a leading **version byte** so the key/algorithm can rotate without breaking stored ciphertext, and **AAD bound to the Notion workspace id** so a ciphertext authenticated for one workspace cannot be relocated to another row.

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
const aad = 'notion-workspace-123'

describe('token-cipher', () => {
  it('round-trips a plaintext token with matching AAD', () => {
    const ciphertext = encryptToken('secret-notion-token', keyB64, aad)
    expect(decryptToken(ciphertext, keyB64, aad)).toBe('secret-notion-token')
  })

  it('produces different ciphertext each call (random IV) and is not the plaintext', () => {
    const a = encryptToken('same', keyB64, aad)
    const b = encryptToken('same', keyB64, aad)
    expect(a).not.toBe(b)
    expect(a).not.toContain('same')
  })

  it('writes a recognizable version byte as the first byte of the envelope', () => {
    const ciphertext = encryptToken('secret', keyB64, aad)
    expect(Buffer.from(ciphertext, 'base64')[0]).toBe(1)
  })

  it('rejects decryption with a different AAD (workspace binding)', () => {
    const ciphertext = encryptToken('secret', keyB64, aad)
    expect(() => decryptToken(ciphertext, keyB64, 'different-workspace')).toThrow()
  })

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    const ciphertext = encryptToken('secret', keyB64, aad)
    const buf = Buffer.from(ciphertext, 'base64')
    buf[buf.length - 1] ^= 0x01 // flip a bit in the ciphertext
    expect(() => decryptToken(buf.toString('base64'), keyB64, aad)).toThrow()
  })

  it('rejects decryption with the wrong key', () => {
    const ciphertext = encryptToken('secret', keyB64, aad)
    const otherKey = randomBytes(32).toString('base64')
    expect(() => decryptToken(ciphertext, otherKey, aad)).toThrow()
  })

  it('rejects a key that is not 32 bytes', () => {
    const shortKey = randomBytes(16).toString('base64')
    expect(() => encryptToken('secret', shortKey, aad)).toThrow(/32 bytes/)
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
const VERSION = 1 // bump when the key or algorithm rotates; decrypt dispatches on this byte
const IV_BYTES = 12 // 96-bit GCM nonce — fresh random per encryption
const TAG_BYTES = 16

function decodeKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64')
  if (key.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes')
  }
  return key
}

/**
 * Encrypts plaintext with AES-256-GCM, binding the ciphertext to `aad`
 * (e.g. the Notion workspace id). Output = base64(version || iv || authTag || ciphertext).
 */
export function encryptToken(plaintext: string, keyB64: string, aad: string): string {
  const key = decodeKey(keyB64)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]).toString('base64')
}

/** Reverses encryptToken; throws if the version, key, AAD, or auth tag does not match. */
export function decryptToken(encoded: string, keyB64: string, aad: string): string {
  const key = decodeKey(keyB64)
  const buf = Buffer.from(encoded, 'base64')
  const version = buf[0]
  if (version !== VERSION) {
    throw new Error(`Unsupported token cipher version: ${version}`)
  }
  const iv = buf.subarray(1, 1 + IV_BYTES)
  const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES)
  const ciphertext = buf.subarray(1 + IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test -- --run lib/crypto/token-cipher.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/crypto/token-cipher.ts lib/crypto/token-cipher.test.ts
git commit -m "feat(crypto): add versioned aad-bound aes-256-gcm token cipher"
```

---

### Task 4: HMAC-signed OAuth state

The signed state carries `{ u: userId, n: nonce, e: expiry }`. The signature prevents forgery and the `u` binding prevents login-CSRF; the `n` nonce is **also written to a first-party cookie in Task 7 and consumed on callback in Task 8**, which is what makes the state effectively one-time (replay defense).

**Files:**
- Create: `lib/notion/oauth-state.ts`
- Test: `lib/notion/oauth-state.test.ts`

- [ ] **Step 1: Write the failing test**

`lib/notion/oauth-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { signState, verifyState, OAUTH_NONCE_COOKIE } from './oauth-state'

const secret = 'a-sufficiently-long-state-secret'
const now = 1_000_000

describe('oauth-state', () => {
  it('exposes a stable cookie name', () => {
    expect(OAUTH_NONCE_COOKIE).toBe('notion_oauth_nonce')
  })

  it('round-trips a signed state', () => {
    const token = signState({ u: 'user_123', n: 'nonce', e: now + 1000 }, secret)
    expect(verifyState(token, secret, now)).toEqual({ u: 'user_123', n: 'nonce', e: now + 1000 })
  })

  it('rejects a state signed with a different secret', () => {
    const token = signState({ u: 'user_123', n: 'nonce', e: now + 1000 }, secret)
    expect(verifyState(token, 'another-secret-entirely', now)).toBeNull()
  })

  it('rejects a tampered body', () => {
    const token = signState({ u: 'user_123', n: 'nonce', e: now + 1000 }, secret)
    const sig = token.split('.')[1]
    const forged = Buffer.from('{"u":"attacker","n":"n","e":9999999}').toString('base64url')
    expect(verifyState(`${forged}.${sig}`, secret, now)).toBeNull()
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

/** First-party cookie that mirrors the state nonce for one-time replay defense. */
export const OAUTH_NONCE_COOKIE = 'notion_oauth_nonce'

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
  if (typeof payload.u !== 'string' || typeof payload.n !== 'string') return null
  if (typeof payload.e !== 'number' || payload.e < nowMs) return null
  return payload
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test -- --run lib/notion/oauth-state.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/notion/oauth-state.ts lib/notion/oauth-state.test.ts
git commit -m "feat(notion): add hmac-signed oauth state with nonce cookie name"
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

  it('exchanges a code and maps the response (contract test)', async () => {
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

### Task 6: Tenant-scoped connection data access (via membership)

All reads/writes resolve the workspace through `WorkspaceMember` keyed by the authenticated `userId`, then scope by `workspaceId` (ADR-3). No table carries a single-owner assumption beyond the relaxable `@@unique([userId])`.

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
    workspaceMember: { findUnique: vi.fn(async () => null) },
    workspace: {
      create: vi.fn(async () => ({ id: 'ws_new' })),
      findFirst: vi.fn(async () => null),
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
  it('creates a workspace + owner membership for a new user, then upserts the connection', async () => {
    const prisma = fakePrisma()
    const result = await saveNotionConnection(prisma, input)
    expect(result).toEqual({ workspaceId: 'ws_new' })
    expect(prisma.workspace.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          members: { create: { userId: 'user_123', role: 'owner' } },
        }),
      }),
    )
    expect(prisma.notionConnection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'ws_new' } }),
    )
  })

  it('reuses the existing workspace for a returning user', async () => {
    const prisma = fakePrisma({
      workspaceMember: { findUnique: vi.fn(async () => ({ workspaceId: 'ws_existing', userId: 'user_123' })) },
      workspace: { create: vi.fn(), findFirst: vi.fn() },
    })
    const result = await saveNotionConnection(prisma, input)
    expect(result).toEqual({ workspaceId: 'ws_existing' })
    expect(prisma.workspace.create).not.toHaveBeenCalled()
    expect(prisma.notionConnection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'ws_existing' } }),
    )
  })
})

describe('getWorkspaceForUser', () => {
  it('reads the workspace via membership with its connection', async () => {
    const prisma = fakePrisma({
      workspace: {
        findFirst: vi.fn(async () => ({ id: 'ws_1', notionConnection: { id: 'conn_1' } })),
        create: vi.fn(),
      },
    })
    const ws = await getWorkspaceForUser(prisma, 'user_123')
    expect(ws).toMatchObject({ id: 'ws_1' })
    expect(prisma.workspace.findFirst).toHaveBeenCalledWith({
      where: { members: { some: { userId: 'user_123' } } },
      include: { notionConnection: true },
    })
  })
})

describe('disconnectNotion', () => {
  it('returns false when there is no connection', async () => {
    const prisma = fakePrisma({
      workspace: { findFirst: vi.fn(async () => ({ id: 'ws_1', notionConnection: null })), create: vi.fn() },
    })
    expect(await disconnectNotion(prisma, 'user_123')).toBe(false)
  })

  it('deletes the connection and returns true when present', async () => {
    const del = vi.fn(async () => ({ id: 'conn_1' }))
    const prisma = fakePrisma({
      workspace: {
        findFirst: vi.fn(async () => ({ id: 'ws_1', notionConnection: { id: 'conn_1' } })),
        create: vi.fn(),
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
 * Resolves (or creates) the user's workspace via WorkspaceMember, then upserts its
 * Notion connection. Tenant-scoped by workspaceId (ADR-3). Reconnecting replaces the
 * stored token. Returns the workspace id.
 */
export async function saveNotionConnection(
  prisma: PrismaClient,
  input: SaveConnectionInput,
): Promise<{ workspaceId: string }> {
  const membership = await prisma.workspaceMember.findUnique({ where: { userId: input.userId } })

  let workspaceId: string
  if (membership) {
    workspaceId = membership.workspaceId
  } else {
    const workspace = await prisma.workspace.create({
      data: {
        name: input.notionWorkspaceName ?? 'My Workspace',
        members: { create: { userId: input.userId, role: 'owner' } },
      },
    })
    workspaceId = workspace.id
  }

  const connectionFields = {
    notionWorkspaceId: input.notionWorkspaceId,
    notionWorkspaceName: input.notionWorkspaceName,
    botId: input.botId,
    encryptedToken: input.encryptedToken,
  }

  await prisma.notionConnection.upsert({
    where: { workspaceId },
    create: { workspaceId, ...connectionFields },
    update: connectionFields,
  })

  return { workspaceId }
}

export async function getWorkspaceForUser(prisma: PrismaClient, userId: string) {
  return prisma.workspace.findFirst({
    where: { members: { some: { userId } } },
    include: { notionConnection: true },
  })
}

export async function disconnectNotion(prisma: PrismaClient, userId: string): Promise<boolean> {
  const workspace = await prisma.workspace.findFirst({
    where: { members: { some: { userId } } },
    include: { notionConnection: true },
  })
  if (!workspace?.notionConnection) return false
  await prisma.notionConnection.delete({ where: { workspaceId: workspace.id } })
  return true
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test -- --run lib/data/connections.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/data/connections.ts lib/data/connections.test.ts
git commit -m "feat(data): add membership-scoped notion connection access"
```

---

### Task 7: Connect route (signed state + nonce cookie)

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
import { verifyState, OAUTH_NONCE_COOKIE } from '@/lib/notion/oauth-state'
import { GET } from './route'

const mockedAuth = vi.mocked(auth)

describe('GET /api/notion/connect', () => {
  beforeEach(() => vi.clearAllMocks())

  it('redirects an authed user to Notion and sets a nonce cookie matching the state', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    const res = await GET()

    const location = res.headers.get('location') ?? ''
    expect(location).toContain('https://api.notion.com/v1/oauth/authorize')
    expect(location).toContain('client_id=cid')

    const state = new URL(location).searchParams.get('state') ?? ''
    const payload = verifyState(state, 'a-sufficiently-long-state-secret', Date.now())
    expect(payload?.u).toBe('user_123')

    const cookie = res.cookies.get(OAUTH_NONCE_COOKIE)
    expect(cookie?.value).toBe(payload?.n)
    expect(cookie?.httpOnly).toBe(true)
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
import { signState, OAUTH_NONCE_COOKIE } from '@/lib/notion/oauth-state'

const STATE_TTL_MS = 10 * 60 * 1000

export async function GET() {
  const env = getEnv()
  const { userId } = await auth()

  if (!userId) {
    return NextResponse.redirect(new URL('/sign-in', env.NEXT_PUBLIC_APP_URL))
  }

  const nonce = randomBytes(16).toString('hex')
  const state = signState(
    { u: userId, n: nonce, e: Date.now() + STATE_TTL_MS },
    env.OAUTH_STATE_SECRET,
  )

  const authorizeUrl = buildAuthorizeUrl({
    clientId: env.NOTION_OAUTH_CLIENT_ID,
    redirectUri: env.NOTION_OAUTH_REDIRECT_URI,
    state,
  })

  const res = NextResponse.redirect(authorizeUrl)
  res.cookies.set(OAUTH_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax', // sent on the top-level GET redirect back from Notion
    path: '/',
    maxAge: STATE_TTL_MS / 1000,
  })
  return res
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test -- --run app/api/notion/connect/route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/notion/connect/route.ts app/api/notion/connect/route.test.ts
git commit -m "feat(notion): add oauth connect route with state nonce cookie"
```

---

### Task 8: Callback route (verify + consume nonce, encrypt, persist)

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
import { signState, OAUTH_NONCE_COOKIE } from '@/lib/notion/oauth-state'
import { GET } from './route'

const mockedAuth = vi.mocked(auth)
const SECRET = 'a-sufficiently-long-state-secret'

function reqWith(params: Record<string, string>, nonceCookie?: string): NextRequest {
  const url = new URL('https://app.test/api/notion/callback')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const headers = nonceCookie ? { cookie: `${OAUTH_NONCE_COOKIE}=${nonceCookie}` } : undefined
  return new NextRequest(url, headers ? { headers } : undefined)
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
    const res = await GET(reqWith({ code: 'abc', state }, 'n'))
    expect(res.headers.get('location')).toBe('https://app.test/app?notion=invalid')
    expect(exchangeCodeForToken).not.toHaveBeenCalled()
  })

  it('rejects when the nonce cookie is missing or does not match the state (replay defense)', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    const state = signState({ u: 'user_123', n: 'nonce-A', e: Date.now() + 60_000 }, SECRET)
    const res = await GET(reqWith({ code: 'abc', state }, 'nonce-B')) // cookie mismatch
    expect(res.headers.get('location')).toBe('https://app.test/app?notion=invalid')
    expect(exchangeCodeForToken).not.toHaveBeenCalled()
  })

  it('exchanges, persists encrypted token, clears the cookie, and redirects on a valid callback', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as never)
    exchangeCodeForToken.mockResolvedValue({
      accessToken: 'tok',
      botId: 'bot',
      workspaceId: 'ws_notion',
      workspaceName: 'Acme',
    })
    const state = signState({ u: 'user_123', n: 'nonce-A', e: Date.now() + 60_000 }, SECRET)
    const res = await GET(reqWith({ code: 'abc', state }, 'nonce-A'))

    expect(res.headers.get('location')).toBe('https://app.test/app?notion=connected')
    expect(saveNotionConnection).toHaveBeenCalledOnce()
    const [, savedInput] = saveNotionConnection.mock.calls[0] as [unknown, { encryptedToken: string; userId: string }]
    expect(savedInput.userId).toBe('user_123')
    expect(savedInput.encryptedToken).not.toContain('tok') // stored encrypted, never plaintext
    // cookie cleared (maxAge 0)
    expect(res.cookies.get(OAUTH_NONCE_COOKIE)?.value).toBe('')
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
import { verifyState, OAUTH_NONCE_COOKIE } from '@/lib/notion/oauth-state'
import { encryptToken } from '@/lib/crypto/token-cipher'
import { saveNotionConnection } from '@/lib/data/connections'

function redirectToApp(appUrl: string, status: string): NextResponse {
  const res = NextResponse.redirect(new URL(`/app?notion=${status}`, appUrl))
  res.cookies.set(OAUTH_NONCE_COOKIE, '', { path: '/', maxAge: 0 }) // consume the nonce
  return res
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
  const cookieNonce = req.cookies.get(OAUTH_NONCE_COOKIE)?.value
  if (!payload || payload.u !== userId || !cookieNonce || cookieNonce !== payload.n) {
    return redirectToApp(appUrl, 'invalid')
  }

  try {
    const token = await exchangeCodeForToken({
      code,
      clientId: env.NOTION_OAUTH_CLIENT_ID,
      clientSecret: env.NOTION_OAUTH_CLIENT_SECRET,
      redirectUri: env.NOTION_OAUTH_REDIRECT_URI,
    })

    // AAD binds the ciphertext to this Notion workspace (known before any DB write).
    const encryptedToken = encryptToken(token.accessToken, env.TOKEN_ENCRYPTION_KEY, token.workspaceId)

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
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/notion/callback/route.ts app/api/notion/callback/route.test.ts
git commit -m "feat(notion): add oauth callback with nonce consume and encrypted storage"
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

- [ ] **Manual OAuth smoke checklist** (requires a real Notion OAuth app + dev Postgres; set the new `.env` values, then `npm run dev`):
  1. Sign in via Clerk and open `/app` — the **Connect Notion** button renders (no connection yet).
  2. Click **Connect Notion** — browser redirects to `api.notion.com/v1/oauth/authorize`; confirm a `notion_oauth_nonce` cookie was set on our domain.
  3. Approve in Notion — Notion redirects to `/api/notion/callback?...`.
  4. Land on `/app?notion=connected` showing the connected workspace name; confirm the `notion_oauth_nonce` cookie is gone (consumed).
  5. In the DB, confirm a `Workspace` + owner `WorkspaceMember` + `NotionConnection` row exist and `encryptedToken` is **not** the plaintext Notion token.
  6. Click **Disconnect Notion** — the `NotionConnection` row is deleted and the **Connect Notion** button returns.
  7. Replay check: re-open the captured callback URL after step 4 — it lands on `/app?notion=invalid` (nonce already consumed / code already used).

## Spec coverage check

- **M1 scope "OAuth connect/disconnect, AES-GCM encrypted token at rest":** connect route (Task 7), callback exchange + persist (Task 8), disconnect (Task 9), AES-256-GCM cipher (Task 3) — token stored only as ciphertext (asserted in Task 8 test).
- **A01 / ADR-3 tenant scoping:** identity is `workspaceId`; user→workspace via `WorkspaceMember`; every data-access call scoped accordingly (Tasks 1, 6).
- **A02 Cryptographic Failures:** AES-256-GCM, fresh 96-bit IV per encryption, AAD bound to `notionWorkspaceId`, versioned envelope for rotation, key from env (KMS-migration path documented); token never logged (Task 3).
- **A03 Injection / input validation:** zod-validated token-exchange response (Task 5, contract test); callback validates presence of `code`/`state` (Task 8).
- **A07 Auth failures / CSRF + replay:** HMAC-signed, user-bound, 10-min-expiry `state` (Tasks 4, 7, 8) **plus** a first-party `HttpOnly; SameSite=Lax` nonce cookie cross-checked and consumed on callback (Tasks 7, 8) for one-time replay defense.
- **A09 startup integrity:** `pingDatabase` connectivity check surfaces DB problems before live smoke (Task 1).
- **Prereq #12 (Prisma generator + datasource):** discharged by Task 1 (real models generate + migrate + ping).

## Deferred (not in this milestone, by design)

- **Team features** — the `WorkspaceMember` table exists so tenant identity is `workspaceId`, but multi-member workspaces / roles beyond `owner` / invitations are out of MVP scope (spec §11). Relaxing `@@unique([userId])` is the single change to enable them later — no token-data migration.
- **KMS for the encryption key** — env-managed for MVP; migrate to a KMS/secret-manager in M7 hardening. The ciphertext version byte makes that rotation non-breaking.
- **Token refresh/rotation + audit-log sink** — M1 stores and deletes; rotation hygiene lands with the embed-token work (M5) and observability (M6).
- **DB-backed one-time state store** — the cookie-nonce gives browser-bound one-time replay defense without new infrastructure; if a stricter cross-device single-use guarantee is ever needed, a short-TTL nonce table or Redis (available M5) can replace it.
- **Notion SDK + actual workspace scanning** — M2.
