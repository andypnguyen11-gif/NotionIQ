import { PrismaClient } from '@prisma/client'

export function createPrismaSingleton<T>(globalRef: { prisma?: T }, factory: () => T): T {
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
