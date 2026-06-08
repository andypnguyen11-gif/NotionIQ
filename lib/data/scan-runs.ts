import type { PrismaClient, Prisma } from '@prisma/client'

export interface DbResult {
  notionDatabaseId: string
  status: 'scanned' | 'mapped' | 'failed'
  errorCode?: string
}

export async function createScanRun(
  prisma: PrismaClient,
  input: { workspaceId: string; selectedDatabaseIds: string[] },
): Promise<{ id: string }> {
  const run = await prisma.workspaceScanRun.create({
    data: { workspaceId: input.workspaceId, status: 'queued', selectedDatabaseIds: input.selectedDatabaseIds },
    select: { id: true },
  })
  return run
}

export async function getScanRunForWorkspace(
  prisma: PrismaClient,
  args: { workspaceId: string; scanRunId: string },
) {
  return prisma.workspaceScanRun.findFirst({ where: { id: args.scanRunId, workspaceId: args.workspaceId } })
}

export async function setRunResults(
  prisma: PrismaClient,
  args: {
    scanRunId: string
    status: string
    results?: DbResult[]
    error?: string
    mapperModel?: string
    mapperPromptVersion?: string
    propertyCount?: number
    sampleRowCount?: number
  },
): Promise<void> {
  await prisma.workspaceScanRun.update({
    where: { id: args.scanRunId },
    data: {
      status: args.status,
      results: args.results as Prisma.InputJsonValue | undefined,
      error: args.error,
      mapperModel: args.mapperModel,
      mapperPromptVersion: args.mapperPromptVersion,
      propertyCount: args.propertyCount,
      sampleRowCount: args.sampleRowCount,
    },
  })
}
