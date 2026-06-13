// lib/jobs/run-report.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runReport, type RunReportDeps } from './run-report'
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'
import type { MetricRecord } from '@/lib/contracts/normalized'

const mapping: DatabaseMappingProposal = {
  classification: 'sales', occurredAtPropertyId: null,
  fields: [{ notionPropertyId: 'amt', name: 'Amount', notionType: 'number', candidateRole: 'measure', role: 'measure', confidence: 1, rationale: '' }],
  modelVersion: 'm', promptVersion: 'p',
}
const rec = (amt: number): MetricRecord => ({ occurredAt: null, mappedFields: { measures: { amt: { name: 'Amount', value: amt } }, dimensions: {}, status: {} } })
const sumFactId = '3::db1::sum::amt::-::-'
const goodClaim = { section: 'metric' as const, template: 'Total {value}.', assertion: { kind: 'value' as const, factId: sumFactId, expected: 30 } }

function baseDeps(over: Partial<RunReportDeps> = {}): RunReportDeps {
  return {
    clock: () => '2026-06-12T00:00:00.000Z',
    loadRun: vi.fn(async () => ({ workspaceId: 'ws_1', currentVersion: 3, runSnapshotVersion: 3 })),
    loadFactInputs: vi.fn(async () => ({ dbs: [{ sourceDatabaseId: 'db1', mapping, current: [rec(10), rec(20)], previous: [] }], context: { databases: [{ sourceDatabaseId: 'db1', classification: 'sales' }] } })),
    draft: vi.fn(async () => ({ claims: [goodClaim], inputTokens: 10, outputTokens: 5, model: 'claude-sonnet-4-6', promptVersion: 'insight-v1' })),
    repair: vi.fn(async () => ({ claims: [goodClaim], inputTokens: 3, outputTokens: 2, model: 'claude-sonnet-4-6', promptVersion: 'insight-v1' })),
    persistClaims: vi.fn(async () => undefined),
    setStatus: vi.fn(async () => undefined),
    loadReportPointer: vi.fn(async () => ({ notionPageId: null, ownedBlockIds: [], parentPageId: 'parent_1' })),
    writeReport: vi.fn(async () => ({ notionPageId: 'page_1', ownedBlockIds: ['b0', 'b1'] })),
    upsertReport: vi.fn(async () => undefined),
    deleteOldBlocks: vi.fn(async () => undefined),
    loadVerifiedClaims: vi.fn(async () => []),
    ...over,
  }
}
const statuses = (deps: RunReportDeps) => (deps.setStatus as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].status)

describe('runReport', () => {
  it('full happy path: persist claims -> write -> upsert pointer -> delete old, then commits', async () => {
    const order: string[] = []
    const deps = baseDeps({
      persistClaims: vi.fn(async () => { order.push('persist') }),
      writeReport: vi.fn(async () => { order.push('write'); return { notionPageId: 'page_1', ownedBlockIds: ['b0'] } }),
      upsertReport: vi.fn(async () => { order.push('upsert') }),
      deleteOldBlocks: vi.fn(async () => { order.push('deleteOld') }),
    })
    await runReport(deps, { reportRunId: 'run_1', mode: 'full' })
    expect(order).toEqual(['persist', 'write', 'upsert', 'deleteOld'])
    expect(deps.upsertReport).toHaveBeenCalled()
    expect(statuses(deps)).toContain('committed')
    expect(deps.draft).toHaveBeenCalledTimes(1)
    expect(deps.repair).not.toHaveBeenCalled() // good claim verified first time
  })

  it('deletes the OLD pointer block ids AFTER persisting the new pointer', async () => {
    const order: string[] = []
    const deps = baseDeps({
      loadReportPointer: vi.fn(async () => ({ notionPageId: 'page_1', ownedBlockIds: ['old1', 'old2'], parentPageId: 'p' })),
      upsertReport: vi.fn(async () => { order.push('upsert') }),
      deleteOldBlocks: vi.fn(async () => { order.push('deleteOld') }),
    })
    await runReport(deps, { reportRunId: 'run_1', mode: 'full' })
    expect(deps.deleteOldBlocks).toHaveBeenCalledWith({ workspaceId: 'ws_1', blockIds: ['old1', 'old2'] })
    expect(order.indexOf('upsert')).toBeLessThan(order.indexOf('deleteOld'))
  })

  it('runs exactly one repair when a drafted claim fails verification', async () => {
    const badClaim = { section: 'metric' as const, template: 'Total {value}.', assertion: { kind: 'value' as const, factId: sumFactId, expected: 999 } }
    const deps = baseDeps({ draft: vi.fn(async () => ({ claims: [badClaim], inputTokens: 10, outputTokens: 5, model: 'm', promptVersion: 'insight-v1' })) })
    await runReport(deps, { reportRunId: 'run_1', mode: 'full' })
    expect(deps.repair).toHaveBeenCalledTimes(1)
    expect(statuses(deps)).toContain('committed')
  })

  it('write failure -> write_failed, with claims already persisted', async () => {
    const deps = baseDeps({ writeReport: vi.fn(async () => { throw new Error('notion 500') }) })
    await runReport(deps, { reportRunId: 'run_1', mode: 'full' })
    expect(deps.persistClaims).toHaveBeenCalled()
    expect(statuses(deps)).toContain('write_failed')
    expect(deps.upsertReport).not.toHaveBeenCalled()
    expect(deps.deleteOldBlocks).not.toHaveBeenCalled()
  })

  it('no snapshot data -> failed before persistence', async () => {
    const deps = baseDeps({ loadFactInputs: vi.fn(async () => null) })
    await runReport(deps, { reportRunId: 'run_1', mode: 'full' })
    expect(deps.persistClaims).not.toHaveBeenCalled()
    expect(statuses(deps)).toContain('failed')
  })

  it('write_only mode: no AI, write -> upsert -> delete old, commits', async () => {
    const order: string[] = []
    const deps = baseDeps({
      loadReportPointer: vi.fn(async () => ({ notionPageId: 'page_1', ownedBlockIds: ['old1'], parentPageId: 'p' })),
      loadVerifiedClaims: vi.fn(async () => [{ ...goodClaim, verificationStatus: 'verified' as const, renderedText: 'Total 30.' }]),
      writeReport: vi.fn(async () => { order.push('write'); return { notionPageId: 'page_1', ownedBlockIds: ['b0'] } }),
      upsertReport: vi.fn(async () => { order.push('upsert') }),
      deleteOldBlocks: vi.fn(async () => { order.push('deleteOld') }),
    })
    await runReport(deps, { reportRunId: 'run_1', mode: 'write_only' })
    expect(deps.draft).not.toHaveBeenCalled()
    expect(deps.repair).not.toHaveBeenCalled()
    expect(deps.writeReport).toHaveBeenCalled()
    expect(order).toEqual(['write', 'upsert', 'deleteOld'])
    expect(deps.deleteOldBlocks).toHaveBeenCalledWith({ workspaceId: 'ws_1', blockIds: ['old1'] })
    expect(statuses(deps)).toContain('committed')
  })

  it('write_only write failure -> write_failed', async () => {
    const deps = baseDeps({
      loadVerifiedClaims: vi.fn(async () => [{ ...goodClaim, verificationStatus: 'verified' as const, renderedText: 'Total 30.' }]),
      writeReport: vi.fn(async () => { throw new Error('notion 500') }),
    })
    await runReport(deps, { reportRunId: 'run_1', mode: 'write_only' })
    expect(statuses(deps)).toContain('write_failed')
  })
})
