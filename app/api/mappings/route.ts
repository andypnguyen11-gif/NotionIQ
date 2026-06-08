import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getPrisma } from '@/lib/prisma'
import { getWorkspaceForUser } from '@/lib/data/connections'
import { listMappingsForRun } from '@/lib/data/mappings'

export async function GET(req: NextRequest) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const scanRunId = new URL(req.url).searchParams.get('scanRunId')
  const prisma = getPrisma()
  const workspace = await getWorkspaceForUser(prisma, userId)
  if (!workspace) return NextResponse.json({ error: 'no_workspace' }, { status: 400 })
  if (!scanRunId) return NextResponse.json({ error: 'invalid_request' }, { status: 400 })

  const mappings = await listMappingsForRun(prisma, { workspaceId: workspace.id, scanRunId })
  return NextResponse.json({ mappings })
}
