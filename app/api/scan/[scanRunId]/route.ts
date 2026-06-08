import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getPrisma } from '@/lib/prisma'
import { getWorkspaceForUser } from '@/lib/data/connections'
import { getScanRunForWorkspace } from '@/lib/data/scan-runs'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ scanRunId: string }> }) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { scanRunId } = await params

  const prisma = getPrisma()
  const workspace = await getWorkspaceForUser(prisma, userId)
  if (!workspace) return NextResponse.json({ error: 'no_workspace' }, { status: 400 })

  const run = await getScanRunForWorkspace(prisma, { workspaceId: workspace.id, scanRunId })
  if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  return NextResponse.json({ scanRunId: run.id, status: run.status, results: run.results ?? [] })
}
