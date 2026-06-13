// lib/data/reports.test.ts
import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import {
  createReportRun, claimReportRunForRewrite, setReportRunStatus,
  getReportRunForWorkspace, upsertReport, getReport,
} from './reports'

function fakePrisma(reportRun: Record<string, unknown> = {}, report: Record<string, unknown> = {}) {
  return {
    reportRun: {
      create: vi.fn(async () => ({ id: 'run_1' })),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
      ...reportRun,
    },
    report: {
      upsert: vi.fn(async () => ({ id: 'rep_1' })),
      findUnique: vi.fn(async () => null),
      ...report,
    },
  } as unknown as PrismaClient
}

describe('reports data access', () => {
  it('creates a queued run when none is in flight', async () => {
    const prisma = fakePrisma()
    const res = await createReportRun(prisma, { workspaceId: 'ws_1' })
    expect(res).toEqual({ id: 'run_1', created: true })
    expect(prisma.reportRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: { workspaceId: 'ws_1', status: 'queued' } }))
  })

  it('single-flight: active includes rewriting; returns the in-flight run', async () => {
    const prisma = fakePrisma({ findFirst: vi.fn(async () => ({ id: 'run_active' })) })
    const res = await createReportRun(prisma, { workspaceId: 'ws_1' })
    expect(res).toEqual({ id: 'run_active', created: false })
    expect(prisma.reportRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'ws_1', status: { in: ['queued', 'running', 'rewriting'] } } }),
    )
  })

  it('on a P2002 create race, returns the winning run', async () => {
    const findFirst = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'run_winner' })
    const create = vi.fn(async () => { throw Object.assign(new Error('unique'), { code: 'P2002' }) })
    const prisma = fakePrisma({ findFirst, create })
    expect(await createReportRun(prisma, { workspaceId: 'ws_1' })).toEqual({ id: 'run_winner', created: false })
  })

  it('claimReportRunForRewrite flips write_failed -> rewriting, workspace-scoped, returns true on success', async () => {
    const prisma = fakePrisma({ updateMany: vi.fn(async () => ({ count: 1 })) })
    const ok = await claimReportRunForRewrite(prisma, { workspaceId: 'ws_1', reportRunId: 'run_1' })
    expect(ok).toBe(true)
    expect(prisma.reportRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run_1', workspaceId: 'ws_1', status: 'write_failed' },
      data: { status: 'rewriting' },
    })
  })

  it('claimReportRunForRewrite returns false when nothing was claimed', async () => {
    const prisma = fakePrisma({ updateMany: vi.fn(async () => ({ count: 0 })) })
    expect(await claimReportRunForRewrite(prisma, { workspaceId: 'ws_1', reportRunId: 'run_1' })).toBe(false)
  })

  it('claimReportRunForRewrite returns false on a P2002 (another active run won)', async () => {
    const prisma = fakePrisma({ updateMany: vi.fn(async () => { throw Object.assign(new Error('u'), { code: 'P2002' }) }) })
    expect(await claimReportRunForRewrite(prisma, { workspaceId: 'ws_1', reportRunId: 'run_1' })).toBe(false)
  })

  it('setReportRunStatus is tenant-scoped via updateMany', async () => {
    const prisma = fakePrisma()
    await setReportRunStatus(prisma, { workspaceId: 'ws_1', reportRunId: 'run_1', status: 'committed', snapshotVersion: 3, markFinished: true })
    const arg = (prisma.reportRun.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg.where).toEqual({ id: 'run_1', workspaceId: 'ws_1' })
    expect(arg.data.status).toBe('committed')
    expect(arg.data.finishedAt).toBeInstanceOf(Date)
  })

  it('reads a run only within its workspace', async () => {
    const prisma = fakePrisma({ findFirst: vi.fn(async () => ({ id: 'run_1', workspaceId: 'ws_1', status: 'committed' })) })
    await getReportRunForWorkspace(prisma, { workspaceId: 'ws_1', reportRunId: 'run_1' })
    expect(prisma.reportRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'run_1', workspaceId: 'ws_1' } }))
  })

  it('upsertReport writes the managed pointer scoped by workspace', async () => {
    const prisma = fakePrisma()
    await upsertReport(prisma, { workspaceId: 'ws_1', notionPageId: 'p1', ownedBlockIds: ['b1'], lastRunId: 'run_1', lastSnapshotVersion: 3, lastGeneratedAt: new Date() })
    const arg = (prisma.report.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg.where).toEqual({ workspaceId: 'ws_1' })
  })

  it('getReport reads the managed report by workspace', async () => {
    const prisma = fakePrisma({}, { findUnique: vi.fn(async () => ({ id: 'rep_1', notionPageId: 'p1', ownedBlockIds: [] })) })
    await getReport(prisma, { workspaceId: 'ws_1' })
    expect(prisma.report.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: 'ws_1' } }))
  })
})
