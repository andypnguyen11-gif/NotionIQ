import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { getEnv } from './env'

export function createPrismaSingleton<T>(globalRef: { prisma?: T }, factory: () => T): T {
  if (!globalRef.prisma) {
    globalRef.prisma = factory()
  }
  return globalRef.prisma
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

// Lazy: do NOT construct PrismaClient at import time. App code calls getPrisma() at
// request time. The Prisma 7 driver-adapter engine requires an adapter at construction.
export function getPrisma(): PrismaClient {
  return createPrismaSingleton(globalForPrisma, () => {
    const adapter = new PrismaPg(getEnv().DATABASE_URL)
    return new PrismaClient({ adapter })
  })
}
