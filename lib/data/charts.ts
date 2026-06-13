import type { PrismaClient, Prisma } from '@prisma/client'
import { ChartConfigSchema, type ChartConfig } from '@/lib/contracts/chart'
import { log } from '@/lib/log'

export interface ChartRecord {
  id: string
  workspaceId: string
  sourceDatabaseId: string
  config: ChartConfig
  title: string
  snapshotVersionAtCreate: number
}

// Always writes config.shape into the shape column so the two can never drift on insert.
export async function createChart(
  prisma: PrismaClient,
  args: { workspaceId: string; sourceDatabaseId: string; config: ChartConfig; title: string; snapshotVersionAtCreate: number },
): Promise<{ id: string }> {
  const created = await prisma.chart.create({
    data: {
      workspaceId: args.workspaceId,
      sourceDatabaseId: args.sourceDatabaseId,
      shape: args.config.shape,
      config: args.config as unknown as Prisma.InputJsonValue,
      title: args.title,
      snapshotVersionAtCreate: args.snapshotVersionAtCreate,
    },
  })
  return { id: created.id }
}

// Tenant-scoped (ADR-3): workspaceId is always in the WHERE.
export async function getChart(prisma: PrismaClient, args: { workspaceId: string; chartId: string }): Promise<ChartRecord | null> {
  const found = await prisma.chart.findFirst({ where: { id: args.chartId, workspaceId: args.workspaceId } })
  return found ? parseRow(found) : null
}

export async function listCharts(prisma: PrismaClient, args: { workspaceId: string }): Promise<ChartRecord[]> {
  const rows = await prisma.chart.findMany({ where: { workspaceId: args.workspaceId }, orderBy: { createdAt: 'asc' } })
  const out: ChartRecord[] = []
  for (const r of rows) {
    const parsed = parseRow(r)
    if (parsed) out.push(parsed)
  }
  return out
}

// safeParse + shape-drift guard: one bad row never blanks the list or throws (M3/M7 ethos).
function parseRow(row: {
  id: string
  workspaceId: string
  sourceDatabaseId: string
  shape: string
  config: unknown
  title: string
  snapshotVersionAtCreate: number
}): ChartRecord | null {
  const parsed = ChartConfigSchema.safeParse(row.config)
  if (!parsed.success || parsed.data.shape !== row.shape) {
    log.warn('chart_config_skipped', {
      chartId: row.id,
      workspaceId: row.workspaceId,
      reason: parsed.success ? 'shape_mismatch' : 'invalid_config',
    })
    return null
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sourceDatabaseId: row.sourceDatabaseId,
    config: parsed.data,
    title: row.title,
    snapshotVersionAtCreate: row.snapshotVersionAtCreate,
  }
}
