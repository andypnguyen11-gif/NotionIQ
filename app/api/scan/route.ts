import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@clerk/nextjs/server'
import { getEnv } from '@/lib/env'
import { getPrisma } from '@/lib/prisma'
import { getWorkspaceForUser } from '@/lib/data/connections'
import { createScanRun } from '@/lib/data/scan-runs'
import { enqueueScan } from '@/lib/jobs/queue'
import { log } from '@/lib/log'

const Body = z.object({ databaseIds: z.array(z.string().min(1)).min(1).max(100) })

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
  if (!isSameOrigin(req, getEnv().NEXT_PUBLIC_APP_URL)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 })

  const prisma = getPrisma()
  const workspace = await getWorkspaceForUser(prisma, userId)
  if (!workspace) return NextResponse.json({ error: 'no_workspace' }, { status: 400 })

  const run = await createScanRun(prisma, { workspaceId: workspace.id, selectedDatabaseIds: parsed.data.databaseIds })
  await enqueueScan(run.id)
  log.info('scan_enqueued', { userId, workspaceId: workspace.id, scanRunId: run.id, databaseCount: parsed.data.databaseIds.length })
  return NextResponse.json({ scanRunId: run.id }, { status: 202 })
}
