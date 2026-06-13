import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { createSnapshotRun, getSnapshotRunForWorkspace, setSnapshotRunStatus } from './snapshot-runs'

function fakePrisma(snapshotRun: Record<string, unknown> = {}) {
  return {
    snapshotRun: {
      create: vi.fn(async () => ({ id: 'run_1' })),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({ id: 'run_1' })),
      ...snapshotRun,
    },
  } as unknown as PrismaClient
}

describe('snapshot-runs', () => {
  it('creates a queued run scoped to the workspace when none is in flight', async () => {
    const prisma = fakePrisma()
    const res = await createSnapshotRun(prisma, { workspaceId: 'ws_1' })
    expect(res).toEqual({ id: 'run_1', created: true })
    expect(prisma.snapshotRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: { workspaceId: 'ws_1', status: 'queued' } }))
  })

  it('single-flight: returns the in-flight run without creating a second one', async () => {
    const prisma = fakePrisma({ findFirst: vi.fn(async () => ({ id: 'run_active' })) })
    const res = await createSnapshotRun(prisma, { workspaceId: 'ws_1' })
    expect(res).toEqual({ id: 'run_active', created: false })
    expect(prisma.snapshotRun.create).not.toHaveBeenCalled()
    // the in-flight lookup is workspace-scoped and limited to active statuses
    expect(prisma.snapshotRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'ws_1', status: { in: ['queued', 'running'] } } }),
    )
  })

  it('single-flight: on a unique-violation race, returns the run that won the race', async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null) // initial check: looked idle
      .mockResolvedValueOnce({ id: 'run_winner' }) // post-conflict re-read
    const create = vi.fn(async () => {
      throw Object.assign(new Error('unique'), { code: 'P2002' })
    })
    const prisma = fakePrisma({ findFirst, create })
    const res = await createSnapshotRun(prisma, { workspaceId: 'ws_1' })
    expect(res).toEqual({ id: 'run_winner', created: false })
  })

  it('rethrows non-unique create errors', async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error('boom'), { code: 'P2010' })
    })
    const prisma = fakePrisma({ create })
    await expect(createSnapshotRun(prisma, { workspaceId: 'ws_1' })).rejects.toThrow('boom')
  })

  it('reads a run only within its workspace (tenant scoped)', async () => {
    const prisma = fakePrisma({ findFirst: vi.fn(async () => ({ id: 'run_1', workspaceId: 'ws_1', status: 'committed' })) })
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
