// app/api/report/route.ts
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getEnv } from '@/lib/env'
import { getPrisma } from '@/lib/prisma'
import { getWorkspaceForUser } from '@/lib/data/connections'
import { createReportRun } from '@/lib/data/reports'
import { enqueueReport } from '@/lib/jobs/report-queue'
import { log } from '@/lib/log'

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

  const prisma = getPrisma()
  const workspace = await getWorkspaceForUser(prisma, userId)
  if (!workspace) return NextResponse.json({ error: 'no_workspace' }, { status: 400 })

  const run = await createReportRun(prisma, { workspaceId: workspace.id })
  if (run.created) {
    await enqueueReport(run.id, 'full')
    log.info('report_enqueued', { userId, workspaceId: workspace.id, reportRunId: run.id })
  } else {
    log.info('report_already_in_flight', { userId, workspaceId: workspace.id, reportRunId: run.id })
  }
  return NextResponse.json({ reportRunId: run.id }, { status: 202 })
}
