import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@clerk/nextjs/server'
import { getEnv } from '@/lib/env'
import { getPrisma } from '@/lib/prisma'
import { getWorkspaceForUser } from '@/lib/data/connections'
import { approveMapping, listApprovedStatuses, isRunFullyApproved } from '@/lib/data/mappings'
import { applyEdits } from '@/lib/mapping/merge'
import { RoleSchema, type DatabaseMappingProposal } from '@/lib/contracts/mapping'
import { log } from '@/lib/log'

const Body = z.object({ occurredAtPropertyId: z.string().nullable(), roles: z.record(z.string(), RoleSchema) })

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

  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 })

  const prisma = getPrisma()
  const workspace = await getWorkspaceForUser(prisma, userId)
  if (!workspace) return NextResponse.json({ error: 'no_workspace' }, { status: 400 })

  const mapping = await prisma.databaseMapping.findFirst({ where: { id, workspaceId: workspace.id } })
  if (!mapping) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  let approved: DatabaseMappingProposal
  try {
    approved = applyEdits(mapping.proposedMapping as DatabaseMappingProposal, parsed.data)
  } catch {
    return NextResponse.json({ error: 'invalid_edits' }, { status: 400 })
  }

  const result = await approveMapping(prisma, { workspaceId: workspace.id, mappingId: id, approved })
  if (!result) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const run = await prisma.workspaceScanRun.findFirst({ where: { id: result.lastScanRunId, workspaceId: workspace.id } })
  if (run) {
    const selected = run.selectedDatabaseIds as string[]
    const approvedIds = await listApprovedStatuses(prisma, { workspaceId: workspace.id, notionDatabaseIds: selected })
    const results = (run.results ?? []) as { notionDatabaseId: string; status: 'scanned' | 'mapped' | 'failed' }[]
    if (isRunFullyApproved(results, approvedIds)) {
      await prisma.workspaceScanRun.update({ where: { id: run.id }, data: { status: 'approved' } })
    }
  }

  log.info('mapping_approved', { userId, workspaceId: workspace.id, mappingId: id })
  return NextResponse.json({ approved: true })
}
