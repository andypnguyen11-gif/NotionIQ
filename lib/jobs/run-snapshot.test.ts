import { describe, it, expect, vi } from 'vitest'
import { runSnapshot, type RunSnapshotDeps } from './run-snapshot'
import { sum } from '@/lib/metrics/primitives'
import type { TypedRow } from '@/lib/contracts/normalized'
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'

const mapping: DatabaseMappingProposal = {
  classification: 'sales',
  occurredAtPropertyId: null,
  fields: [{ notionPropertyId: 'p1', name: 'Amount', notionType: 'number', candidateRole: 'measure', role: 'measure', confidence: 1, rationale: '' }],
  modelVersion: 'm',
  promptVersion: 'p',
}
const rows: TypedRow[] = [
  { notionPageId: 'pg1', values: { p1: { kind: 'number', value: 10 } } },
  { notionPageId: 'pg2', values: { p1: { kind: 'number', value: 20 } } },
]

function deps(over: Partial<RunSnapshotDeps> = {}): RunSnapshotDeps {
  return {
    loadRun: vi.fn(async () => ({ workspaceId: 'ws_1', currentVersion: 0 })),
    loadApprovedMappings: vi.fn(async () => [{ notionDatabaseId: 'db1', approvedMapping: mapping }]),
    cleanOrphans: vi.fn(async () => {}),
    read: vi.fn(async () => rows),
    write: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    ...over,
  }
}

describe('runSnapshot', () => {
  it('ingests every db, commits N+1, and marks the run committed', async () => {
    const d = deps()
    await runSnapshot(d, 'run_1')
    expect(d.cleanOrphans).toHaveBeenCalledWith('ws_1', 0)
    expect(d.write).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws_1', sourceDatabaseId: 'db1', snapshotVersion: 1 }))
    expect(d.commit).toHaveBeenCalledWith('ws_1', 1)
    expect(d.setStatus).toHaveBeenLastCalledWith('run_1', expect.objectContaining({ status: 'committed', snapshotVersion: 1, markFinished: true }))
    expect(d.read).toHaveBeenCalledWith('ws_1', 'db1')
  })

  it('refuses when there are no approved mappings', async () => {
    const d = deps({ loadApprovedMappings: vi.fn(async () => []) })
    await runSnapshot(d, 'run_1')
    expect(d.commit).not.toHaveBeenCalled()
    expect(d.setStatus).toHaveBeenLastCalledWith('run_1', expect.objectContaining({ status: 'failed' }))
  })

  it('does NOT commit when any db fails — old snapshot stays live (all-or-nothing)', async () => {
    const d = deps({
      loadApprovedMappings: vi.fn(async () => [
        { notionDatabaseId: 'db1', approvedMapping: mapping },
        { notionDatabaseId: 'db2', approvedMapping: mapping },
      ]),
      read: vi.fn(async (_workspaceId: string, id: string) => { if (id === 'db2') throw new Error('notion down'); return rows }),
    })
    await runSnapshot(d, 'run_1')
    expect(d.commit).not.toHaveBeenCalled()
    expect(d.setStatus).toHaveBeenLastCalledWith('run_1', expect.objectContaining({ status: 'partial' }))
  })

  it('integration: normalized rows written for db1 sum to the right number', async () => {
    const stored: Parameters<RunSnapshotDeps['write']>[0][] = []
    const d = deps({ write: vi.fn(async (args) => { stored.push(args) }) })
    await runSnapshot(d, 'run_1')
    const recs = stored[0].records.map((r) => ({ occurredAt: r.occurredAt, mappedFields: r.mappedFields }))
    expect(sum(recs, 'p1')).toBe(30)
  })
})
