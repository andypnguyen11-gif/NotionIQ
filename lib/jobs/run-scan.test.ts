import { describe, it, expect, vi } from 'vitest'
import { runScan } from './run-scan'

const scannedDb = { notionDatabaseId: 'db1', databaseName: 'Sales', properties: [{ id: 'p1', name: 'Amount', notionType: 'number' }], sample: [] }
const proposal = { classification: 'x', occurredAtPropertyId: null, fields: [], modelVersion: 'm', promptVersion: 'mapper-v1' }

function deps(over: Record<string, unknown> = {}) {
  return {
    loadRun: vi.fn(async () => ({ workspaceId: 'ws_1', selectedDatabaseIds: ['db1'] })),
    scan: vi.fn(async () => [scannedDb]),
    map: vi.fn(async () => ({ proposal, inputTokens: 1, outputTokens: 1, model: 'm' })),
    upsert: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    ...over,
  }
}

describe('runScan', () => {
  it('scans, maps, upserts, and finishes the run as proposed', async () => {
    const d = deps()
    await runScan(d as never, 'run_1')
    expect(d.upsert).toHaveBeenCalledTimes(1)
    expect(d.finish).toHaveBeenCalledWith('run_1', expect.objectContaining({ status: 'proposed', results: [{ notionDatabaseId: 'db1', status: 'mapped' }] }))
  })

  it('records a per-db failure but still finishes proposed', async () => {
    const d = deps({ map: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'MAPPER_INVALID_OUTPUT' }) }) })
    await runScan(d as never, 'run_1')
    expect(d.finish).toHaveBeenCalledWith('run_1', expect.objectContaining({
      status: 'proposed',
      results: [{ notionDatabaseId: 'db1', status: 'failed', errorCode: 'MAPPER_INVALID_OUTPUT' }],
    }))
  })

  it('marks the whole run failed on a fatal load/scan error', async () => {
    const d = deps({ scan: vi.fn(async () => { throw new Error('notion down') }) })
    await runScan(d as never, 'run_1')
    expect(d.finish).toHaveBeenCalledWith('run_1', expect.objectContaining({ status: 'failed' }))
  })
})
