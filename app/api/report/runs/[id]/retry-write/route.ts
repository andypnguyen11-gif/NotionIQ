// app/api/report/runs/[id]/retry-write/route.ts
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getEnv } from '@/lib/env'
import { getPrisma } from '@/lib/prisma'
import { getWorkspaceForUser } from '@/lib/data/connections'
import { claimReportRunForRewrite } from '@/lib/data/reports'
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

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req, getEnv().NEXT_PUBLIC_APP_URL)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params

  const prisma = getPrisma()
  const workspace = await getWorkspaceForUser(prisma, userId)
  if (!workspace) return NextResponse.json({ error: 'no_workspace' }, { status: 400 })

  const claimed = await claimReportRunForRewrite(prisma, { workspaceId: workspace.id, reportRunId: id })
  if (!claimed) return NextResponse.json({ error: 'not_retryable' }, { status: 409 })

  await enqueueReport(id, 'write_only')
  log.info('report_retry_write', { userId, workspaceId: workspace.id, reportRunId: id })
  return NextResponse.json({ reportRunId: id }, { status: 202 })
}
