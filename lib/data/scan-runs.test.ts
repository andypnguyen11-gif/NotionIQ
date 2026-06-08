import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { createScanRun, getScanRunForWorkspace, setRunResults } from './scan-runs'

function fakePrisma(over: Record<string, unknown> = {}) {
  return {
    workspaceScanRun: {
      create: vi.fn(async () => ({ id: 'run_1' })),
      findFirst: vi.fn(async () => ({ id: 'run_1', workspaceId: 'ws_1', status: 'proposed' })),
      update: vi.fn(async () => ({ id: 'run_1' })),
    },
    ...over,
  } as unknown as PrismaClient
}

describe('scan-runs', () => {
  it('creates a queued run scoped to the workspace', async () => {
    const prisma = fakePrisma()
    const res = await createScanRun(prisma, { workspaceId: 'ws_1', selectedDatabaseIds: ['db1'] })
    expect(res).toEqual({ id: 'run_1' })
    expect(prisma.workspaceScanRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ workspaceId: 'ws_1', status: 'queued', selectedDatabaseIds: ['db1'] }) }),
    )
  })

  it('reads a run only within its workspace (tenant scoped)', async () => {
    const prisma = fakePrisma()
    await getScanRunForWorkspace(prisma, { workspaceId: 'ws_1', scanRunId: 'run_1' })
    expect(prisma.workspaceScanRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'run_1', workspaceId: 'ws_1' } }),
    )
  })

  it('updates results + status', async () => {
    const prisma = fakePrisma()
    await setRunResults(prisma, { scanRunId: 'run_1', status: 'proposed', results: [{ notionDatabaseId: 'db1', status: 'mapped' }] })
    expect(prisma.workspaceScanRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'run_1' }, data: expect.objectContaining({ status: 'proposed' }) }),
    )
  })
})
