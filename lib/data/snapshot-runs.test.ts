import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { createSnapshotRun, getSnapshotRunForWorkspace, setSnapshotRunStatus } from './snapshot-runs'

function fakePrisma(over: Record<string, unknown> = {}) {
  return {
    snapshotRun: {
      create: vi.fn(async () => ({ id: 'run_1' })),
      findFirst: vi.fn(async () => ({ id: 'run_1', workspaceId: 'ws_1', status: 'committed' })),
      update: vi.fn(async () => ({ id: 'run_1' })),
    },
    ...over,
  } as unknown as PrismaClient
}

describe('snapshot-runs', () => {
  it('creates a queued run scoped to the workspace', async () => {
    const prisma = fakePrisma()
    const res = await createSnapshotRun(prisma, { workspaceId: 'ws_1' })
    expect(res).toEqual({ id: 'run_1' })
    expect(prisma.snapshotRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: { workspaceId: 'ws_1', status: 'queued' } }))
  })

  it('reads a run only within its workspace (tenant scoped)', async () => {
    const prisma = fakePrisma()
    await getSnapshotRunForWorkspace(prisma, { workspaceId: 'ws_1', snapshotRunId: 'run_1' })
    expect(prisma.snapshotRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'run_1', workspaceId: 'ws_1' } }))
  })

  it('marks a run running and stamps startedAt', async () => {
    const prisma = fakePrisma()
    await setSnapshotRunStatus(prisma, { snapshotRunId: 'run_1', status: 'running', markStarted: true })
    const data = (prisma.snapshotRun.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data
    expect(data.status).toBe('running')
    expect(data.startedAt).toBeInstanceOf(Date)
  })

  it('commits a run with version, results and finishedAt', async () => {
    const prisma = fakePrisma()
    await setSnapshotRunStatus(prisma, { snapshotRunId: 'run_1', status: 'committed', snapshotVersion: 3, results: [{ sourceDatabaseId: 'db1', status: 'ingested', rowCount: 2 }], markFinished: true })
    const data = (prisma.snapshotRun.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data
    expect(data).toEqual(expect.objectContaining({ status: 'committed', snapshotVersion: 3 }))
    expect(data.finishedAt).toBeInstanceOf(Date)
  })
})
