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

// Lazy: do NOT parse at import time (keeps tests/tooling from throwing on a
// partially-populated env). App code calls getEnv() at request/boot time.
let cached: Env | undefined
export function getEnv(): Env {
  if (!cached) cached = parseEnv(process.env)
  return cached
}
