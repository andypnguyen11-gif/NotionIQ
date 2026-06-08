import { z } from 'zod'

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
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
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

// Lazy: do NOT parse at import time (keeps tests/tooling from throwing on a
// partially-populated env). App code calls getEnv() at request/boot time.
let cached: Env | undefined
export function getEnv(): Env {
  if (!cached) cached = parseEnv(process.env)
  return cached
}
