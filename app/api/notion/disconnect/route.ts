import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getEnv } from '@/lib/env'
import { getPrisma } from '@/lib/prisma'
import { disconnectNotion } from '@/lib/data/connections'
import { log } from '@/lib/log'

// Route handlers are not covered by Next's built-in Server Action CSRF check (which
// compares Origin to Host), so we enforce same-origin ourselves: a same-origin
// fetch POST always sends `Origin`, so a missing or mismatched origin is rejected.
function isSameOrigin(req: NextRequest, appUrl: string): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return false
  try {
    return new URL(origin).host === new URL(appUrl).host
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const env = getEnv()
  if (!isSameOrigin(req, env.NEXT_PUBLIC_APP_URL)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const disconnected = await disconnectNotion(getPrisma(), userId)
  log.info('notion_disconnected', { userId, disconnected })
  return NextResponse.json({ disconnected })
}
