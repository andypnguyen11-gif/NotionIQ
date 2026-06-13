import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getEnv } from '@/lib/env'
import { getPrisma } from '@/lib/prisma'
import { getWorkspaceForUser } from '@/lib/data/connections'
import { listApprovedMappings } from '@/lib/data/mappings'
import { createSnapshotRun } from '@/lib/data/snapshot-runs'
import { enqueueSnapshot } from '@/lib/jobs/snapshot-queue'
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

  const approved = await listApprovedMappings(prisma, workspace.id)
  if (approved.length === 0) return NextResponse.json({ error: 'no_approved_mappings' }, { status: 400 })

  // Single-flight: createSnapshotRun returns the existing in-flight run (created=false)
  // rather than starting a second one. Only enqueue a job for a run we actually created;
  // double-enqueuing would let two workers process the same run concurrently.
  const run = await createSnapshotRun(prisma, { workspaceId: workspace.id })
  if (run.created) {
    await enqueueSnapshot(run.id)
    log.info('snapshot_enqueued', { userId, workspaceId: workspace.id, snapshotRunId: run.id, databaseCount: approved.length })
  } else {
    log.info('snapshot_already_in_flight', { userId, workspaceId: workspace.id, snapshotRunId: run.id })
  }
  return NextResponse.json({ snapshotRunId: run.id }, { status: 202 })
}
