import { describe, it, expect } from 'vitest'
import { parseEnv } from './env'

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x',
  CLERK_SECRET_KEY: 'sk_test_x',
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
    expect(() => parseEnv({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    })).toThrow(/CLERK/)
  })
})
