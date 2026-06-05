import type { PrismaClient } from '@prisma/client'

/** Verifies the database is reachable with a trivial query. Throws on failure. */
export async function pingDatabase(prisma: PrismaClient): Promise<boolean> {
  await prisma.$queryRaw`SELECT 1`
  return true
}
