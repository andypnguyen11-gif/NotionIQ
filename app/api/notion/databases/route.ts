import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getEnv } from '@/lib/env'
import { getPrisma } from '@/lib/prisma'
import { getConnectionForUser } from '@/lib/data/connections'
import { decryptToken } from '@/lib/crypto/token-cipher'
import { createNotionClient } from '@/lib/notion/notion-client'
import { createRateLimiter } from '@/lib/notion/rate-limiter'

const MAX_PAGES = 5 // bounded: at most 500 databases listed

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const conn = await getConnectionForUser(getPrisma(), userId)
  if (!conn) return NextResponse.json({ databases: [] })

  const env = getEnv()
  const token = decryptToken(conn.encryptedToken, env.TOKEN_ENCRYPTION_KEY, conn.notionWorkspaceId)
  const client = createNotionClient({ token, rateLimiter: createRateLimiter({ ratePerSec: 3 }) })

  const databases = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const { databases: batch, nextCursor } = await client.searchDatabases({ cursor })
    databases.push(...batch)
    if (!nextCursor) break
    cursor = nextCursor
  }
  return NextResponse.json({ databases })
}
