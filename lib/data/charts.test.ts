import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { createChart, getChart, listCharts } from './charts'
import type { ChartConfig } from '@/lib/contracts/chart'

const config: ChartConfig = { shape: 'kpi', metric: { metric: 'count' } }
const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1', workspaceId: 'w1', sourceDatabaseId: 'db1', shape: 'kpi', config, title: 'T', snapshotVersionAtCreate: 3, ...over,
})

function fakePrisma(over: Record<string, unknown> = {}) {
  return {
    chart: {
      create: vi.fn(async () => ({ id: 'c1' })),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      ...over,
    },
  } as unknown as PrismaClient
}

describe('createChart', () => {
  it('writes config.shape into the shape column (drift guard) scoped to the workspace', async () => {
    const prisma = fakePrisma()
    const res = await createChart(prisma, { workspaceId: 'w1', sourceDatabaseId: 'db1', config, title: 'T', snapshotVersionAtCreate: 3 })
    expect(res).toEqual({ id: 'c1' })
    expect(prisma.chart.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ workspaceId: 'w1', shape: 'kpi', title: 'T', snapshotVersionAtCreate: 3 }),
    }))
  })
})

describe('getChart', () => {
  it('scopes the lookup by workspaceId AND chartId (ADR-3)', async () => {
    const prisma = fakePrisma({ findFirst: vi.fn(async () => row()) })
    const res = await getChart(prisma, { workspaceId: 'w1', chartId: 'c1' })
    expect(res).toMatchObject({ id: 'c1', config })
    expect(prisma.chart.findFirst).toHaveBeenCalledWith({ where: { id: 'c1', workspaceId: 'w1' } })
  })
  it('returns null for a row whose stored shape disagrees with config.shape', async () => {
    const prisma = fakePrisma({ findFirst: vi.fn(async () => row({ shape: 'categorical' })) })
    expect(await getChart(prisma, { workspaceId: 'w1', chartId: 'c1' })).toBeNull()
  })
})

describe('listCharts', () => {
  it('skips a corrupt-config row instead of throwing', async () => {
    const prisma = fakePrisma({ findMany: vi.fn(async () => [row(), row({ id: 'bad', config: { shape: 'kpi' } /* missing metric */ })]) })
    const res = await listCharts(prisma, { workspaceId: 'w1' })
    expect(res).toHaveLength(1)
    expect(res[0].id).toBe('c1')
    expect(prisma.chart.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: 'w1' } }))
  })
})
