import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseEnv, getEnv } from './env'

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x',
  CLERK_SECRET_KEY: 'sk_test_x',
  NOTION_OAUTH_CLIENT_ID: 'cid',
  NOTION_OAUTH_CLIENT_SECRET: 'csecret',
  NOTION_OAUTH_REDIRECT_URI: 'http://localhost:3000/api/notion/callback',
  TOKEN_ENCRYPTION_KEY: 'Z'.repeat(44),
  OAUTH_STATE_SECRET: 'a-sufficiently-long-state-secret',
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

  it('requires Clerk keys', () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
      }),
    ).toThrow(/CLERK/)
  })

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
})

describe('getEnv', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('memoizes: repeated calls return the same cached object', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test_x')
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_x')
    vi.stubEnv('NOTION_OAUTH_CLIENT_ID', 'cid')
    vi.stubEnv('NOTION_OAUTH_CLIENT_SECRET', 'csecret')
    vi.stubEnv('NOTION_OAUTH_REDIRECT_URI', 'http://localhost:3000/api/notion/callback')
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'Z'.repeat(44))
    vi.stubEnv('OAUTH_STATE_SECRET', 'a-sufficiently-long-state-secret')
    const a = getEnv()
    const b = getEnv()
    expect(a).toBe(b)
  })
})
