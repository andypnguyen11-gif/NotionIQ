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

  it('propagates the error when the query fails', async () => {
    const queryRaw = vi.fn(async () => {
      throw new Error('connection refused')
    })
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient
    await expect(pingDatabase(prisma)).rejects.toThrow('connection refused')
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
